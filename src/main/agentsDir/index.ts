// Disk reader + cache for the .agents/ spine (design 3.1). Reads project
// `.agents/rules/*.md` + `.agents/workflows/*.md` and global
// `~/.bearcode/agents/rules/*.md` + `~/.bearcode/agents/workflows/*.md`,
// merges each pair (project wins on filename collision), and resolves
// `@path` cross-references inside each RULE body only (design 3.1: workflow
// bodies get no cross-ref resolution, a `@x` token there stays literal).
// Pure Node builtins only, no new deps. Malformed or missing content never
// throws (design 11 / Global Constraints): callers always get back an
// AgentsContent, at worst empty.
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { readFileCapped } from '../fsCapped'
import { parseRuleFile } from './parseRule'
import { parseSkillFolder } from './parseSkill'
import { parseWorkflowFile } from './parseWorkflow'
import type { AgentsContent, Rule, Skill, Workflow } from './types'
import type { OutsideFolderAccess } from '../../shared/types'

// Loader-side outside-of-folder policy (design §7). Consumed by the ref
// resolver (Task 3) to decide whether an absolute @-ref outside the project
// folder is inlined, dropped-pending, or dropped-denied. Kept local to the
// loader (not re-exported from shared/types) since only main-process loader
// code needs the allow/deny lists alongside the policy.
export interface OutsidePolicy {
  policy: OutsideFolderAccess
  allowed: string[]
  denied: string[]
}

const MAX_REF_BYTES = 64 * 1024
// Rule files themselves get the same cap as cross-refs: a rule is prompt
// text, so anything past 64KB is pathological, and routing the primary read
// through readFileCapped means an arbitrarily large .agents/rules/*.md can
// never be materialized in memory either (security review item 3).
const MAX_RULE_BYTES = MAX_REF_BYTES
// Workflow files are prompt text too; same cap and same rationale.
const MAX_WORKFLOW_BYTES = MAX_REF_BYTES
// SKILL.md is prompt text too; same cap and same rationale.
const MAX_SKILL_BYTES = MAX_REF_BYTES

// readFileCapped (bounded, stat-gated file read; security review item 1) now
// lives in ../fsCapped, shared with mcp/store.ts.

interface CacheEntry {
  mtimeMs: number
  rule: Rule // fully resolved (cross-refs already inlined)
}

// Cache of the FINAL (post cross-reference-resolution) Rule, keyed by
// absolute file path AND the projectPath the resolution ran against. A load
// re-stats every file it finds on disk and only re-parses + re-resolves
// files whose mtime changed since the last pass, or that are new --
// unchanged files return the exact same Rule object as the previous load (no
// fs watcher; a turn start and a menu open are the only consumers, both
// user-paced, per design 3.1). Including projectPath in the key matters for
// GLOBAL rules specifically: their file path alone does not vary between
// projects, but a global rule's body may contain a relative @path cross-ref,
// whose resolution depends on which project is currently open -- without
// this, switching projects could serve a global rule's cross-ref resolved
// against a stale, different project's workspace.
const cache = new Map<string, CacheEntry>()

// Cache of the parsed Workflow, keyed the same way as the rule cache (path +
// projectPath) for consistency, even though workflow parsing itself never
// depends on projectPath (no cross-ref resolution, design 3.1).
interface WorkflowCacheEntry {
  mtimeMs: number
  workflow: Workflow
}
const workflowCache = new Map<string, WorkflowCacheEntry>()

// Cache of the parsed Skill, keyed the same way as the rule/workflow caches
// (path + projectPath) for consistency, even though skill parsing never
// depends on projectPath (no cross-ref resolution, same as workflows).
interface SkillCacheEntry {
  mtimeMs: number
  skill: Skill
}
const skillCache = new Map<string, SkillCacheEntry>()

function cacheKey(path: string, projectPath: string | null): string {
  return `${projectPath ?? ''}::${path}`
}

function globalRulesDir(): string {
  return join(homedir(), '.bearcode', 'agents', 'rules')
}

function globalWorkflowsDir(): string {
  return join(homedir(), '.bearcode', 'agents', 'workflows')
}

function globalSkillsDir(): string {
  return join(homedir(), '.bearcode', 'agents', 'skills')
}

// Generalized lister (Task 1: was listRuleFiles, now shared by rules and
// workflows -- both are flat directories of *.md files).
function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f))
  } catch {
    // Unreadable directory (permissions, race with deletion, etc.) is treated
    // like a missing one -- never throw out of the loader.
    return []
  }
}

function mdNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

// Load + cache one rule file, resolving its cross-references. Returns null
// if the file can no longer be read (race: deleted between readdir and
// stat/read) -- the caller simply drops it from the result set. Malformed
// files (parseRuleFile sets `error`) are kept with the raw body, never
// cross-ref-resolved and never thrown.
function loadOneRule(
  path: string,
  name: string,
  source: 'project' | 'global',
  projectPath: string | null,
  outside?: OutsidePolicy,
  pendingSink?: Set<string>
): Rule | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }

  // Cache correctness (Task 3 decision 3): fold an outside-policy fingerprint
  // into the cache key for PROJECT rules only. Allowing/denying a
  // previously-pending path changes ref resolution without touching the rule
  // file's own mtime, so the fingerprint must change too or the cache would
  // keep serving the stale (ref-dropped) body.
  const fp =
    source === 'project' && outside
      ? `${outside.policy}|${[...outside.allowed].sort().join(',')}|${[...outside.denied].sort().join(',')}`
      : ''
  const key = cacheKey(path, projectPath) + '|' + fp
  const cached = cache.get(key)
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.rule
  }

  // Bounded primary read: a rule file that is a non-regular file (would
  // block or never end) is dropped like an unreadable one, and an oversized
  // one is truncated at the cap with a warning instead of being read whole.
  const read = readFileCapped(path, MAX_RULE_BYTES)
  if (!read) return null
  const fileWarnings: string[] = read.truncated
    ? [`Rule file exceeds ${MAX_RULE_BYTES / 1024}KB and was truncated`]
    : []

  const parsed = parseRuleFile(name, read.text, source)
  let rule: Rule = parsed
  if (!parsed.error) {
    // Seed the cycle-detection chain with this file's own absolute path, so
    // a ref chain that loops back to the rule file itself is caught.
    const { body, warnings, pendingOutside } = resolveRuleRefs(parsed.body, projectPath, {
      outside: source === 'project' ? outside : undefined,
      inlinedChain: new Set([path])
    })
    if (pendingSink) for (const p of pendingOutside) pendingSink.add(p)
    const allWarnings = [...fileWarnings, ...warnings]
    if (body !== parsed.body || allWarnings.length > 0) {
      rule = { ...parsed, body, warnings: allWarnings.length > 0 ? allWarnings : undefined }
    }
  } else if (fileWarnings.length > 0) {
    rule = { ...parsed, warnings: fileWarnings }
  }

  cache.set(key, { mtimeMs, rule })
  return rule
}

// Load + cache one workflow file. Mirrors loadOneRule minus cross-reference
// resolution (design 3.1: workflow bodies are never ref-resolved). Returns
// null if the file can no longer be read (race: deleted between readdir and
// stat/read) -- the caller simply drops it from the result set. Malformed or
// misnamed files (parseWorkflowFile sets `error`) are kept with the raw body
// so the slash menu can still show a greyed entry.
function loadOneWorkflow(
  path: string,
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): Workflow | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }

  const key = cacheKey(path, projectPath)
  const cached = workflowCache.get(key)
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.workflow
  }

  // Bounded primary read: a workflow file that is a non-regular file (would
  // block or never end) is dropped like an unreadable one, and an oversized
  // one is truncated at the cap with a warning instead of being read whole.
  const read = readFileCapped(path, MAX_WORKFLOW_BYTES)
  if (!read) return null
  const fileWarnings: string[] = read.truncated
    ? [`Workflow file exceeds ${MAX_WORKFLOW_BYTES / 1024}KB and was truncated`]
    : []

  const parsed = parseWorkflowFile(name, read.text, source)
  const workflow: Workflow =
    fileWarnings.length > 0
      ? { ...parsed, warnings: [...(parsed.warnings ?? []), ...fileWarnings] }
      : parsed

  workflowCache.set(key, { mtimeMs, workflow })
  return workflow
}

// A skill is a FOLDER containing SKILL.md (agentskills.io, design 4.1) -- not
// a flat *.md like rules/workflows. Lists <dir>/<skill>/SKILL.md for every
// subdirectory that actually has a SKILL.md; missing/unreadable dir -> [].
function listSkillFolders(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(dir, d.name, 'SKILL.md') }))
      .filter((x) => existsSync(x.path))
  } catch {
    return []
  }
}

// Load + cache one skill's SKILL.md. Mirrors loadOneWorkflow (no
// cross-reference resolution). Returns null if the file can no longer be
// read (race: deleted between readdir and stat/read) -- the caller simply
// drops it from the result set.
function loadOneSkill(
  path: string,
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): Skill | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  const key = cacheKey(path, projectPath)
  const cached = skillCache.get(key)
  if (cached && cached.mtimeMs === mtimeMs) return cached.skill

  const read = readFileCapped(path, MAX_SKILL_BYTES)
  if (!read) return null
  const parsed = parseSkillFolder(name, read.text, source)
  const skill: Skill = read.truncated
    ? { ...parsed, warnings: [`SKILL.md exceeds ${MAX_SKILL_BYTES / 1024}KB and was truncated`] }
    : parsed
  skillCache.set(key, { mtimeMs, skill })
  return skill
}

// Read `<projectPath>/.agents/rules/*.md` + `.agents/workflows/*.md`
// (project) and `~/.bearcode/agents/rules/*.md` +
// `~/.bearcode/agents/workflows/*.md` (global), merge each pair (project
// wins on a filename collision within its own kind -- a rule and a workflow
// may share a name without conflict, they are separate registries here;
// Task 2's command registry is where cross-kind collisions with built-ins
// are handled), and return the live content. Missing directories are treated
// as empty, never an error.
export function loadAgentsContent(
  projectPath: string | null,
  opts?: { trusted?: boolean; outside?: OutsidePolicy }
): AgentsContent {
  // Secure default (Global Constraints / design §7): an unspecified project
  // is untrusted, so a caller that forgets to pass `trusted` never gets
  // project-authored rules/workflows/skills injected into agent context --
  // only the user's own global entries load. `outside` is threaded through
  // for Task 3's ref resolver; this task only builds the (currently always
  // empty) pendingOutside accumulator so the shape is stable end to end.
  const trusted = opts?.trusted ?? false
  const outside = opts?.outside
  const pendingOutside = new Set<string>()
  const projectRulesDir = trusted && projectPath ? join(projectPath, '.agents', 'rules') : null
  const projectRuleFiles = projectRulesDir ? listMdFiles(projectRulesDir) : []
  const globalRuleFiles = listMdFiles(globalRulesDir())

  const rulesByName = new Map<string, Rule>()

  for (const path of globalRuleFiles) {
    const name = mdNameFromPath(path)
    // Global rules keep legacy allow-everything behavior (design decision 2):
    // no outside policy, no pending sink.
    const rule = loadOneRule(path, name, 'global', projectPath)
    if (rule) rulesByName.set(name, rule)
  }
  // Project rules load second and overwrite same-named global entries, so
  // project always wins on collision.
  for (const path of projectRuleFiles) {
    const name = mdNameFromPath(path)
    const rule = loadOneRule(path, name, 'project', projectPath, outside, pendingOutside)
    if (rule) rulesByName.set(name, rule)
  }

  const projectWorkflowsDir =
    trusted && projectPath ? join(projectPath, '.agents', 'workflows') : null
  const projectWorkflowFiles = projectWorkflowsDir ? listMdFiles(projectWorkflowsDir) : []
  const globalWorkflowFiles = listMdFiles(globalWorkflowsDir())

  const workflowsByName = new Map<string, Workflow>()

  for (const path of globalWorkflowFiles) {
    const name = mdNameFromPath(path)
    const workflow = loadOneWorkflow(path, name, 'global', projectPath)
    if (workflow) workflowsByName.set(name, workflow)
  }
  // Project workflows load second and overwrite same-named global entries,
  // so project always wins on collision.
  for (const path of projectWorkflowFiles) {
    const name = mdNameFromPath(path)
    const workflow = loadOneWorkflow(path, name, 'project', projectPath)
    if (workflow) workflowsByName.set(name, workflow)
  }

  const projectSkillsDir = trusted && projectPath ? join(projectPath, '.agents', 'skills') : null
  const projectSkillFolders = projectSkillsDir ? listSkillFolders(projectSkillsDir) : []
  const globalSkillFolders = listSkillFolders(globalSkillsDir())

  const skillsByName = new Map<string, Skill>()

  for (const f of globalSkillFolders) {
    const s = loadOneSkill(f.path, f.name, 'global', projectPath)
    if (s) skillsByName.set(s.name, s)
  }
  // Project skills load second and overwrite same-named global entries, so
  // project always wins on collision.
  for (const f of projectSkillFolders) {
    const s = loadOneSkill(f.path, f.name, 'project', projectPath)
    if (s) skillsByName.set(s.name, s)
  }

  return {
    rules: Array.from(rulesByName.values()),
    workflows: Array.from(workflowsByName.values()),
    skills: Array.from(skillsByName.values()),
    pendingOutside: Array.from(pendingOutside)
  }
}

// Resolve `@<path>` cross-reference tokens in a rule body (design 2 / 3.1).
//
// Token grammar: an `@` immediately followed by a filesystem path, ending at
// the next whitespace character or end of string (DOCUMENTED CHOICE -- the
// design's Antigravity-replication note describes the resolution order but
// not an exact token grammar for rule-body refs).
//
// Resolution order (design 2, security-authoritative in design 10):
//   1. Absolute path (starts with "/"): read directly, READ-ONLY, allowed to
//      point anywhere on disk (documented Antigravity-parity behavior).
//   2. Otherwise: resolve relative to the workspace root (projectPath) and
//      verify containment with a path-separator boundary check (see
//      isInsideWorkspace below) before reading -- this is the same
//      resolve-then-verify-prefix idiom as fsBackend.ts's jailPath, reused
//      here per the design's explicit instruction. A plain resolve+prefix
//      check (no realpath/symlink resolution) is sufficient because this is
//      read-only TEXT INCLUSION into a prompt, never executed and never
//      written back (design 10).
//
// Unresolvable refs (file missing, escapes the workspace, or a repeat within
// the current resolution chain -- see cycle detection below) are left as the
// literal `@<path>` token in the output and recorded as a warning; this
// function never throws.
//
// Work bounds (security review item 2). Three cooperating guards:
// - `inlinedChain` (per recursion PATH): the set of absolute paths inlined
//   along the current chain, seeded by the caller with the rule file's own
//   path, so a cycle (A -> B -> A) is detected and the repeat left literal
//   with a cycle warning instead of recursing forever.
// - `visited` (GLOBAL per top-level resolution): every file ever inlined
//   anywhere during one rule's resolution. Without this, branching ref trees
//   do k^depth work (a diamond A -> {B, C} -> D inlines D twice; wider trees
//   explode exponentially) even though no single chain cycles. A file
//   already inlined once anywhere is not inlined again: literal token +
//   warning, making total work linear in DISTINCT files.
// - `inclusions` counter with a hard cap (MAX_INCLUSIONS) and MAX_CHAIN_DEPTH
//   as belt-and-braces ceilings on total inclusions and recursion depth
//   respectively; refs past either bound stay literal with a warning.
const MAX_CHAIN_DEPTH = 40
const MAX_INCLUSIONS = 64

interface ResolveState {
  visited: Set<string>
  inclusions: number
  outside?: OutsidePolicy
  pending: Set<string>
}

export function resolveRuleRefs(
  body: string,
  projectPath: string | null,
  opts?: { outside?: OutsidePolicy; inlinedChain?: Set<string> }
): { body: string; warnings: string[]; pendingOutside: string[] } {
  const state: ResolveState = {
    visited: new Set(),
    inclusions: 0,
    outside: opts?.outside,
    pending: new Set()
  }
  const r = resolveRefsInner(body, projectPath, opts?.inlinedChain ?? new Set(), 0, state)
  return { body: r.body, warnings: r.warnings, pendingOutside: Array.from(state.pending) }
}

function resolveRefsInner(
  body: string,
  projectPath: string | null,
  inlinedChain: Set<string>,
  depth: number,
  state: ResolveState
): { body: string; warnings: string[] } {
  const warnings: string[] = []
  const tokenPattern = /@(\S+)/g
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(body)) !== null) {
    const token = match[0]
    const refPath = match[1]
    result += body.slice(lastIndex, match.index)
    lastIndex = match.index + token.length

    if (depth >= MAX_CHAIN_DEPTH) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath} (max reference depth exceeded)`)
      continue
    }

    if (state.inclusions >= MAX_INCLUSIONS) {
      result += token
      warnings.push(
        `Could not resolve rule reference: @${refPath} (inclusion limit of ${MAX_INCLUSIONS} reached)`
      )
      continue
    }

    const resolution = resolveRefPath(refPath, projectPath, state.outside)
    if (resolution.pending) state.pending.add(resolution.pending)
    if (!resolution.path) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath}`)
      continue
    }
    const resolved = resolution.path

    if (inlinedChain.has(resolved)) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath} (reference cycle detected)`)
      continue
    }

    if (state.visited.has(resolved)) {
      result += token
      warnings.push(
        `Could not resolve rule reference: @${refPath} (already included once in this rule)`
      )
      continue
    }

    // Bounded, non-regular-rejecting read: a missing file, a directory, a
    // FIFO, a device node, or any read error all degrade to the literal
    // token + warning, and at most MAX_REF_BYTES are ever read.
    const read = readFileCapped(resolved, MAX_REF_BYTES)
    if (!read) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath}`)
      continue
    }

    state.visited.add(resolved)
    state.inclusions += 1

    // Recurse into the referenced file's own content so nested refs resolve
    // too, extending the chain with this file's resolved path so a cycle
    // back to it (or to any ancestor in the chain) is caught.
    const nestedChain = new Set(inlinedChain)
    nestedChain.add(resolved)
    const nested = resolveRefsInner(read.text, projectPath, nestedChain, depth + 1, state)
    warnings.push(...nested.warnings)

    // Read-only text inclusion, never executed: fenced with a header line
    // naming the resolved path so the inclusion is clearly attributed and
    // machine-testable.
    result += `\n--- begin @${refPath} (${resolved}) ---\n${nested.body}\n--- end @${refPath} ---\n`
  }
  result += body.slice(lastIndex)

  return { body: result, warnings }
}

// Resolve one `@<path>` token to an absolute filesystem path, or null if it
// cannot be resolved (missing projectPath for a relative ref, or a relative
// ref that escapes the workspace). Existence is NOT checked here -- callers
// attempt the read and treat a failure the same as an unresolvable path.
//
// Outside-of-folder policy (Task 3, audit C-1): an ABSOLUTE ref that points
// outside the workspace is now gated by `outside` (only ever passed for
// PROJECT-source rules -- global rules keep legacy allow-everything, see
// design decision 2). In-workspace refs (absolute or relative) are always
// resolved regardless of policy.
function resolveRefPath(
  refPath: string,
  projectPath: string | null,
  outside?: OutsidePolicy
): { path: string | null; pending: string | null } {
  if (isAbsolute(refPath)) {
    const abs = resolve(refPath)
    // Inside the workspace? treat like a relative in-folder ref (always ok).
    const root = projectPath ? resolve(projectPath) : null
    if (root && isInsideWorkspace(root, abs)) return { path: abs, pending: null }
    // Out-of-folder absolute ref: apply policy. No policy = legacy allow (global).
    if (!outside || outside.policy === 'allow') return { path: abs, pending: null }
    if (outside.policy === 'deny') return { path: null, pending: null }
    // 'ask': allowed-list wins, denied-list drops, otherwise drop + record pending.
    if (outside.allowed.includes(abs)) return { path: abs, pending: null }
    if (outside.denied.includes(abs)) return { path: null, pending: null }
    return { path: null, pending: abs }
  }
  if (!projectPath) return { path: null, pending: null }
  const root = resolve(projectPath)
  const candidate = resolve(root, refPath)
  return isInsideWorkspace(root, candidate)
    ? { path: candidate, pending: null }
    : { path: null, pending: null }
}

// Boundary-safe containment check (mirrors fsBackend.ts's jailPath idiom,
// reused here per the design's instruction): compares against `root + sep`
// rather than a naive startsWith(root), so a sibling directory that merely
// shares root as a string prefix (e.g. root "/work/proj" and candidate
// "/work/proj-evil/secret") is correctly rejected instead of misclassified
// as inside the workspace.
function isInsideWorkspace(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

// Cheap existence check used by the renderer to decide whether to show the
// "this project has an .agents config" affordance before the user trusts it
// (trust gating itself happens in loadAgentsContent above).
export function hasProjectAgentsConfig(projectPath: string | null): boolean {
  if (!projectPath) return false
  const base = join(projectPath, '.agents')
  return ['rules', 'workflows', 'skills', 'memory'].some((d) => existsSync(join(base, d)))
}
