// Reviewer mode: a deliberate multi-model panel AUDIT of a target through a
// chosen lens, producing structured findings (not prose). Mirrors council.ts's
// panel shape (seats + chair) but is findings-oriented. Rosters are
// code-curated, own table per mode (separate from the councils so they can be
// tuned independently). See planning/2026-07-21-reviewer-mode-design.md.
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { z } from 'zod'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { Event, ReviewFinding, ReviewLens } from '../../shared/types'
import type { RunSink } from '../sink'
import type { CouncilConfig } from './council'
import { eligibleSeats, seatLabel } from './council'
import { makeModel } from './models'
import { keyStatus } from '../keys'
import { appendEvent, getConversationMeta, getEvents } from '../db'
import { parseModelRef } from '../providers/registry'
import { CHEAP_MODEL, maybeGenerateTitle } from '../title'

export const URSA_REVIEW_PANEL: CouncilConfig = {
  seats: ['anthropic/claude-fable-5', 'openai/gpt-5.6-sol', 'xai/grok-4.5'],
  chair: 'anthropic/claude-sonnet-5',
  unavailable:
    'Review needs an Anthropic API key (Sonnet 5 chairs the panel) plus at least one ' +
    'of OpenAI or xAI for the reviewer seats. Add the missing key(s) in Settings > Providers.'
}

const LENSES: readonly ReviewLens[] = [
  'code', 'security', 'accessibility', 'performance', 'comprehensive'
]

const CODE_RUBRIC =
  'CODE QUALITY: correctness bugs, unhandled edge cases, race conditions, resource leaks, ' +
  'dead code, duplicated logic, unclear naming, and missing test coverage for changed behavior.'
const SECURITY_RUBRIC =
  'SECURITY: injection (SQL/command/path), unsafe deserialization, secrets committed in code, ' +
  'missing authz/authn checks, unvalidated input crossing a trust boundary, and risky dependencies.'
const A11Y_RUBRIC =
  'ACCESSIBILITY: missing semantic HTML, keyboard traps or unreachable controls, missing focus ' +
  'management and visible focus, insufficient contrast, missing ARIA/labels, and animations with ' +
  'no prefers-reduced-motion fallback.'
const PERF_RUBRIC =
  'PERFORMANCE: hot-path allocations, N+1 queries or requests, layout thrash and forced reflow, ' +
  'unnecessary re-renders, oversized bundles, and unbounded memory growth.'

const RUBRICS: Record<Exclude<ReviewLens, 'comprehensive'>, string> = {
  code: CODE_RUBRIC,
  security: SECURITY_RUBRIC,
  accessibility: A11Y_RUBRIC,
  performance: PERF_RUBRIC
}

// The lens is the ONLY thing that changes between review types; comprehensive
// concatenates all four checklists into one pass, findings tagged per lens.
export function rubricFor(lens: ReviewLens): string {
  if (lens === 'comprehensive') return Object.values(RUBRICS).join('\n')
  return RUBRICS[lens]
}

// Lightweight lens/scope classifier: reads the user's message, returns whatever
// it can pin down; leaves a field undefined when the user did not clearly say
// (the caller then asks). Runs on a cheap model, same mechanism the Ursa
// classifier uses. Out-of-set lens values are dropped, never trusted.
const RequestSchema = z.object({
  lens: z.string().optional().describe(
    "One of: code, security, accessibility, performance, comprehensive -- ONLY if the user " +
    "clearly indicated which. Omit if they just said 'review this' with no type."
  ),
  scope: z.string().optional().describe(
    "What to review (a path, 'the diff', or 'what was just built') -- ONLY if clearly stated. Omit otherwise."
  )
})

// Prefers a dedicated cheap model on any keyed first-party provider; if none
// is keyed (an all-OpenRouter Ursus setup has no CHEAP_MODEL entry by design),
// falls back to reusing a panel model already in play -- classifying on a
// keyed OpenRouter seat rather than silently refusing to classify at all.
function cheapClassifierRef(panel: CouncilConfig): string | null {
  const status = keyStatus()
  for (const provider of Object.keys(CHEAP_MODEL)) {
    const cheap = CHEAP_MODEL[provider as keyof typeof CHEAP_MODEL]
    if (cheap && status[provider]) return `${provider}/${cheap}`
  }
  for (const ref of [...panel.seats, panel.chair]) {
    if (status[parseModelRef(ref).provider]) return ref
  }
  return null
}

export async function resolveReviewRequest(
  userText: string,
  panel: CouncilConfig
): Promise<{ lens?: ReviewLens; scope?: string }> {
  const ref = cheapClassifierRef(panel)
  if (!ref) return {} // nothing keyed at all -> ask for everything
  const out = (await makeModel(ref)
    .withStructuredOutput(RequestSchema)
    .invoke([
      new SystemMessage(
        'Extract the review LENS and SCOPE from the user message. Only fill a field if the ' +
        'user clearly stated it; otherwise omit it. Do not guess.'
      ),
      new HumanMessage(userText)
    ])) as { lens?: string; scope?: string }
  const lens = LENSES.includes(out.lens as ReviewLens) ? (out.lens as ReviewLens) : undefined
  const scope = typeof out.scope === 'string' && out.scope.trim() ? out.scope.trim() : undefined
  return { lens, scope }
}

// ---- runReview: the panel runner ------------------------------------------
// Gathers the target, has each panel SEAT audit it through the lens rubric
// (parallel, structured findings, toolless), then the CHAIR merges/dedupes and
// assigns final severity. Mirrors runCouncil's eligibility-gate -> parallel-
// seats -> chair -> terminal-state shape (council.ts:238+).

const REVIEW_CONTEXT_CAP = 60_000

const FindingSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'important', 'minor']),
      lens: z.enum(['code', 'security', 'accessibility', 'performance']),
      file: z.string(),
      line: z.number().optional(),
      title: z.string(),
      detail: z.string()
    })
  )
})

const SEAT_SYSTEM = (lens: ReviewLens): string =>
  `You are one reviewer on an expert panel auditing code. Review ONLY through this lens:\n` +
  `${rubricFor(lens)}\n` +
  `Return concrete findings tied to a file (and line when locatable). Be precise; do not invent ` +
  `issues to seem thorough. If the code is clean for this lens, return an empty list.`

const CHAIR_SYSTEM =
  `You chair an expert review panel. Below are the target and every reviewer's raw findings. ` +
  `Produce the FINAL findings list: merge duplicates (same file+issue), drop false positives, ` +
  `and set severity. A finding independently raised by MORE reviewers is more likely real -- ` +
  `weight accordingly. Keep each finding's file/line. Output findings only.`

// Directories never worth walking into when a scope resolves to a directory
// or glob root: build output, VCS metadata, and dependency trees.
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.vite'])

// Recursively collect every FILE path (relative to `root`) under `dir`, in
// sorted (deterministic) order, skipping SKIP_DIRS and dotfiles/dirs.
function listFilesRecursive(dir: string, root: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries.sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) listFilesRecursive(full, root, out)
    else out.push(relative(root, full))
  }
}

// Minimal glob support (v1, per design 6): `*` matches within a path segment,
// `**` matches across segments, `?` matches one character. No brace/negation
// expansion -- scope is classifier-extracted free text, not a build config.
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

// Resolve `scope` to the ordered list of file paths (relative to
// `projectPath`) it names. Three forms: the literal 'what was just built'
// (this conversation's write_file/edit_file tool_calls, dedupe-first-seen), a
// glob (contains *, ?, or [), or a plain path (file or directory, walked
// recursively). Returns [] rather than throwing when nothing resolves.
function resolveScopeFiles(projectPath: string, scope: string, conversationId: string): string[] {
  if (scope === 'what was just built') {
    const seen = new Set<string>()
    const files: string[] = []
    for (const ev of getEvents(conversationId)) {
      if (ev.type !== 'tool_call') continue
      if (ev.tool !== 'write_file' && ev.tool !== 'edit_file') continue
      const raw = (ev.input as { file_path?: unknown } | undefined)?.file_path
      if (typeof raw !== 'string' || !raw) continue
      const rel = raw.startsWith('/') ? raw.slice(1) : raw
      if (!seen.has(rel)) {
        seen.add(rel)
        files.push(rel)
      }
    }
    return files
  }
  if (/[*?[]/.test(scope)) {
    const matcher = globToRegExp(scope)
    const all: string[] = []
    listFilesRecursive(projectPath, projectPath, all)
    return all.filter((rel) => matcher.test(rel))
  }
  const target = resolve(projectPath, scope)
  if (!existsSync(target)) return []
  if (statSync(target).isFile()) return [relative(projectPath, target)]
  const out: string[] = []
  listFilesRecursive(target, projectPath, out)
  return out
}

// Read `scope`'s resolved files into one bounded block ("### <relpath>\n
// <contents>" per file), capped at REVIEW_CONTEXT_CAP chars total. On
// overflow, files are included in listed order until the cap and `note`
// records the honest truncation. Unreadable files (deleted mid-scan, binary
// decode failure) are skipped rather than failing the whole gather. Returns
// null when the scope names no readable file -- the caller emits the
// recoverable "Nothing to review" error. Kept separate from gatherTarget so
// scope resolution can be unit-tested on its own if it grows.
function resolveScopeToBlock(
  projectPath: string | null,
  scope: string,
  conversationId: string
): { block: string; note?: string } | null {
  if (!projectPath) return null
  const files = resolveScopeFiles(projectPath, scope, conversationId)
  if (files.length === 0) return null
  let block = ''
  let included = 0
  for (const rel of files) {
    let contents: string
    try {
      contents = readFileSync(join(projectPath, rel), 'utf8')
    } catch {
      continue
    }
    const section = `### ${rel}\n${contents}\n`
    if (block.length + section.length > REVIEW_CONTEXT_CAP) break
    block += section
    included++
  }
  if (included === 0) return null
  const note =
    included < files.length ? `reviewed ${included} of ${files.length} files (scope truncated)` : undefined
  return { block, note }
}

// Gather the scope's files into one bounded block. Returns null when the
// scope resolves to nothing (caller emits the recoverable "nothing to
// review").
async function gatherTarget(
  conversationId: string,
  scope: string
): Promise<{ block: string; note?: string } | null> {
  const projectPath = getConversationMeta(conversationId)?.projectPath ?? null
  return resolveScopeToBlock(projectPath, scope, conversationId)
}

export async function runReview(
  conversationId: string,
  userText: string,
  lens: ReviewLens,
  scope: string,
  sink: RunSink,
  signal: AbortSignal,
  panel: CouncilConfig
): Promise<{ paused: boolean; failed?: boolean }> {
  const emit = (e: Event): void => {
    sink.emit(conversationId, e)
    appendEvent(conversationId, e)
  }
  const startedAt = Date.now()
  const seats = eligibleSeats(panel.seats)
  const chairProvider = parseModelRef(panel.chair).provider
  if (seats.length === 0 || !keyStatus()[chairProvider]) {
    emit({ type: 'error', id: randomUUID(), message: panel.unavailable, recoverable: true })
    sink.setState(conversationId, 'error')
    return { paused: false, failed: true }
  }
  const target = await gatherTarget(conversationId, scope)
  if (!target) {
    emit({ type: 'error', id: randomUUID(), message: `Nothing to review in ${scope}.`, recoverable: true })
    sink.setState(conversationId, 'error')
    return { paused: false, failed: true }
  }
  // Cost booking is intentionally minimal (v1): withStructuredOutput hides
  // usage_metadata, so per-call usage cannot be booked accurately here. Left
  // empty rather than pushing fake {..,0,0} entries, which would misreport
  // cost -- no ursaCouncilUsage is emitted for review turns. Follow-up.
  const usage: Array<{ modelRef: string; inputTokens: number; outputTokens: number; costUsd?: number }> = []
  const human = (extra = ''): HumanMessage =>
    new HumanMessage(`Review request: ${userText}\n\nTarget:\n${target.block}${extra}`)
  try {
    // Stage 1: seats review in parallel, structured findings, toolless.
    const raw = await Promise.all(
      seats.map(async (seatRef) => {
        try {
          const model = makeModel(seatRef).withStructuredOutput(FindingSchema)
          const res = (await model.invoke([new SystemMessage(SEAT_SYSTEM(lens)), human()], {
            signal
          })) as { findings: ReviewFinding[] }
          return { seatRef, findings: res.findings ?? [] }
        } catch (err) {
          if (signal.aborted) throw err
          return { seatRef, findings: [] as ReviewFinding[] }
        }
      })
    )
    // Stage 2: chair merges (even with 0 findings -> confirms "clean").
    const panelBlock = raw
      .map(
        (r) =>
          `### Reviewer ${seatLabel(r.seatRef)}\n` +
          (r.findings.length ? JSON.stringify(r.findings, null, 2) : '(no findings)')
      )
      .join('\n\n')
    const chair = makeModel(panel.chair).withStructuredOutput(FindingSchema)
    const merged = (await chair.invoke(
      [new SystemMessage(CHAIR_SYSTEM), human(`\n\nReviewers' raw findings:\n${panelBlock}`)],
      { signal }
    )) as { findings: ReviewFinding[] }
    const finals = (merged.findings ?? []).map((f) => ({ ...f, lens: (f.lens ?? lens) as ReviewLens }))
    for (const finding of finals) {
      emit({ type: 'review_finding', id: randomUUID(), finding, createdAt: Date.now() })
    }
    const counts = { critical: 0, important: 0, minor: 0 }
    const byLens: Partial<Record<ReviewLens, number>> = {}
    for (const f of finals) {
      counts[f.severity]++
      byLens[f.lens] = (byLens[f.lens] ?? 0) + 1
    }
    emit({ type: 'review_summary', id: randomUUID(), counts, byLens, note: target.note, createdAt: Date.now() })
    emit({
      type: 'turn_meta',
      id: randomUUID(),
      provider: chairProvider,
      model: parseModelRef(panel.chair).modelId,
      startedAt,
      endedAt: Date.now(),
      ursaRole: 'review',
      ...(usage.length ? { ursaCouncilUsage: usage } : {})
    })
    if (!signal.aborted) {
      void maybeGenerateTitle(
        conversationId,
        chairProvider,
        parseModelRef(panel.chair).modelId,
        userText,
        `Review: ${scope}`,
        (id) => {
          const meta = getConversationMeta(id)
          if (meta) sink.metaChanged(meta)
        }
      )
    }
    sink.setState(conversationId, signal.aborted ? 'cancelled' : 'done')
    return { paused: false }
  } catch (err) {
    const cancelled = signal.aborted
    emit({
      type: 'error',
      id: randomUUID(),
      message: cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err),
      recoverable: true
    })
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
    return { paused: false, failed: true }
  }
}
