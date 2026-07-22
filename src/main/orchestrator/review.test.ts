import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../db', () => ({
  getRecentUrsaContext: vi.fn(() => ''),
  appendEvent: vi.fn(),
  getConversationMeta: vi.fn(() => ({ id: 'c1', title: 't', projectPath: '/project' })),
  getEvents: vi.fn(() => [])
}))
vi.mock('../keys', () => ({ keyStatus: vi.fn(() => ({ anthropic: true, openai: true, xai: true, openrouter: true })) }))
const invokeSpy = vi.hoisted(() => vi.fn())
vi.mock('./models', () => ({ makeModel: vi.fn(() => ({ withStructuredOutput: () => ({ invoke: invokeSpy }) })) }))
vi.mock('../title', () => ({
  CHEAP_MODEL: {
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-5.6-luna',
    google: 'gemini-2.5-flash',
    perplexity: 'sonar',
    xai: 'grok-4-fast'
  },
  maybeGenerateTitle: vi.fn()
}))
// runReview's target-gathering reads the workspace through node's fs -- mock
// it so scope='src' resolves to one trivial file. This test is about panel
// orchestration, not file IO; no real disk is touched. realpathSync is
// identity (no symlinks in this fake tree) -- it's needed because review.ts
// now resolves scope through fsBackend.ts's resolveInWorkspace(), which calls
// realpathSync as its containment core.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn((p: string) => ({
    isDirectory: () => p === '/project/src',
    isFile: () => p !== '/project/src'
  })),
  readdirSync: vi.fn((dir: string) => (dir === '/project/src' ? ['a.ts'] : [])),
  readFileSync: vi.fn(() => 'const x = 1\n'),
  realpathSync: vi.fn((p: string) => p)
}))
// review.ts now reuses fsBackend.ts's resolveInWorkspace() for scope
// containment (jail against path traversal); importing fsBackend.ts pulls in
// its module graph (permissions/diffs/settings/hooks-runner), so mock those
// exactly like fsBackend.test.ts does -- this test only needs the module to
// import cleanly, none of these are exercised by runReview.
vi.mock('../permissions', () => ({
  evaluateEditForConversation: vi.fn(() => 'apply'),
  evaluateCommandForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../diffs', () => ({ stageFile: vi.fn() }))
vi.mock('../settings', () => ({ getSettings: vi.fn(() => ({ fileAccessPolicy: 'deny' })) }))
vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>()
  return { ...actual, interrupt: vi.fn() }
})
vi.mock('../hooks/runner', () => ({
  runPreToolUse: vi.fn(),
  runPostToolUse: vi.fn()
}))

import { URSA_REVIEW_PANEL, rubricFor, resolveReviewRequest, runReview } from './review'
import { URSUS_REVIEW_PANEL } from './ursus'
import { keyStatus } from '../keys'
import type { Event } from '../../shared/types'

describe('review panels', () => {
  it('Ursa panel: 3 diverse seats + Sonnet chair, chair not a seat', () => {
    expect(URSA_REVIEW_PANEL.seats).toEqual([
      'anthropic/claude-fable-5', 'openai/gpt-5.6-sol', 'xai/grok-4.5'
    ])
    expect(URSA_REVIEW_PANEL.chair).toBe('anthropic/claude-sonnet-5')
    expect(URSA_REVIEW_PANEL.seats).not.toContain(URSA_REVIEW_PANEL.chair)
    expect(URSA_REVIEW_PANEL.unavailable).toMatch(/Anthropic/i)
  })
  it('Ursus panel rides entirely on openrouter', () => {
    for (const r of [...URSUS_REVIEW_PANEL.seats, URSUS_REVIEW_PANEL.chair]) {
      expect(r.split('/')[0]).toBe('openrouter')
    }
    expect(URSUS_REVIEW_PANEL.chair).toBe('openrouter/deepseek/deepseek-v4-pro')
  })
})

describe('rubricFor', () => {
  it('returns a distinct non-empty rubric per lens', () => {
    const lenses = ['code','security','accessibility','performance','comprehensive'] as const
    const bodies = lenses.map(rubricFor)
    bodies.forEach((b) => expect(b.length).toBeGreaterThan(20))
    expect(new Set(bodies).size).toBe(bodies.length)          // all different
  })
  it('comprehensive names every lens', () => {
    const c = rubricFor('comprehensive').toLowerCase()
    for (const w of ['security','accessib','performance']) expect(c).toContain(w)
  })
})

describe('resolveReviewRequest', () => {
  beforeEach(() => {
    invokeSpy.mockReset()
    vi.mocked(keyStatus).mockReturnValue({ anthropic: true, openai: true, xai: true, openrouter: true } as ReturnType<
      typeof keyStatus
    >)
  })
  it('passes through an explicit lens + scope from the classifier', async () => {
    invokeSpy.mockResolvedValue({ lens: 'security', scope: 'src/auth' })
    expect(await resolveReviewRequest('audit src/auth for vulns', URSA_REVIEW_PANEL)).toEqual({
      lens: 'security',
      scope: 'src/auth'
    })
  })
  it('leaves fields undefined when the classifier omits them', async () => {
    invokeSpy.mockResolvedValue({})
    expect(await resolveReviewRequest('review this', URSA_REVIEW_PANEL)).toEqual({ lens: undefined, scope: undefined })
  })
  it('drops an out-of-set lens rather than trusting it', async () => {
    invokeSpy.mockResolvedValue({ lens: 'vibes', scope: 'x' })
    const r = await resolveReviewRequest('x', URSA_REVIEW_PANEL)
    expect(r.lens).toBeUndefined()
    expect(r.scope).toBe('x')
  })
  it('falls back to a keyed OpenRouter panel seat for an all-OpenRouter Ursus setup', async () => {
    vi.mocked(keyStatus).mockReturnValue({ openrouter: true } as ReturnType<typeof keyStatus>)
    invokeSpy.mockResolvedValue({ lens: 'security', scope: 'src' })
    expect(await resolveReviewRequest('review src for security', URSUS_REVIEW_PANEL)).toEqual({
      lens: 'security',
      scope: 'src'
    })
  })
})

// seats return raw findings; chair merges. Model factory returns per-ref fakes.
const finding = (over = {}) => ({ severity: 'important', lens: 'security', file: 'a.ts', line: 3, title: 't', detail: 'd', ...over })
function panelModels(seatFindings: Record<string, unknown[]>, chairMerged: unknown[]) {
  return (ref: string) => ({
    withStructuredOutput: () => ({
      invoke: vi.fn(async () =>
        ref === 'anthropic/claude-sonnet-5' ? { findings: chairMerged } : { findings: seatFindings[ref] ?? [] }
      )
    })
  })
}
const sink = () => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
const emitted = (s: any): Event[] => s.emit.mock.calls.map((c: any[]) => c[1])

describe('runReview', () => {
  beforeEach(() => {
    vi.mocked(keyStatus).mockReturnValue({ anthropic: true, openai: true, xai: true, openrouter: true } as ReturnType<
      typeof keyStatus
    >)
  })

  it('runs seats then chair, emits one review_finding per merged finding + a summary', async () => {
    const { makeModel } = await import('./models')
    vi.mocked(makeModel).mockImplementation(panelModels(
      { 'anthropic/claude-fable-5': [finding()], 'openai/gpt-5.6-sol': [finding()], 'xai/grok-4.5': [] },
      [finding({ severity: 'critical' }), finding({ severity: 'minor', file: 'b.ts' })]
    ) as never)
    const s = sink()
    const res = await runReview('c1', 'audit', 'security', 'src', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    expect(res).toEqual({ paused: false })
    const evs = emitted(s)
    expect(evs.filter((e) => e.type === 'review_finding')).toHaveLength(2)
    const summary = evs.find((e) => e.type === 'review_summary') as any
    expect(summary.counts).toEqual({ critical: 1, important: 0, minor: 1 })
  })

  it('recoverable error (no findings emitted) when the chair provider is unkeyed', async () => {
    const { keyStatus } = await import('../keys')
    vi.mocked(keyStatus).mockReturnValue({ openai: true, xai: true } as never) // no anthropic (chair)
    const s = sink()
    const res = await runReview('c1', 'x', 'code', 'src', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    expect(res).toEqual({ paused: false, failed: true })
    expect(emitted(s).some((e) => e.type === 'error')).toBe(true)
    expect(emitted(s).some((e) => e.type === 'review_finding')).toBe(false)
  })

  // FINDING 1 coverage: `scope` is free text an LLM classifier pulled from
  // the user's message. A "../../secret" scope resolves (via path.resolve)
  // to well outside projectPath ('/project') -- resolveInWorkspace must
  // reject it, so resolveScopeFiles returns [] and NO file read ever
  // happens. If the old ad-hoc `resolve(projectPath, scope)` were still in
  // place this would silently read outside the workspace instead.
  it('rejects a scope that resolves outside the workspace -- no read escapes projectPath', async () => {
    const { readFileSync } = await import('fs')
    vi.mocked(readFileSync).mockClear()
    const s = sink()
    const res = await runReview(
      'c1', 'x', 'code', '../../secret', s as never, new AbortController().signal, URSA_REVIEW_PANEL
    )
    expect(res).toEqual({ paused: false, failed: true })
    expect(readFileSync).not.toHaveBeenCalled()
    const evs = emitted(s)
    // Scope resolved to nothing (jailed out) -> the guiding "couldn't find" error.
    expect(evs.some((e) => e.type === 'error' && /couldn't find/i.test((e as any).message))).toBe(true)
    expect(evs.some((e) => e.type === 'review_summary')).toBe(false)
  })

  // FINDING 2 coverage: every seat throwing must NOT look like every seat
  // reviewing and finding nothing clean. The chair must never run, and no
  // review_summary (which would misreport "0 findings" as "code passed
  // review") may be emitted.
  it('fails cleanly (no false "clean" summary) when every seat throws', async () => {
    const { makeModel } = await import('./models')
    vi.mocked(makeModel).mockImplementation(((ref: string) => ({
      withStructuredOutput: () => ({
        invoke: vi.fn(async () => {
          throw new Error(ref === 'anthropic/claude-sonnet-5' ? 'chair should never be invoked' : 'seat down')
        })
      })
    })) as never)
    const s = sink()
    const res = await runReview('c1', 'x', 'code', 'src', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    expect(res).toEqual({ paused: false, failed: true })
    const evs = emitted(s)
    expect(evs.some((e) => e.type === 'error' && /every reviewer failed/i.test((e as any).message))).toBe(true)
    expect(evs.some((e) => e.type === 'review_summary')).toBe(false)
    expect(evs.some((e) => e.type === 'review_finding')).toBe(false)
  })

  // FINDING 3 coverage: a lone file that blows the context cap must not be
  // reported as "nothing to review" (there WAS content, it just didn't fit).
  it('reports "too large" rather than "nothing to review" when the only file exceeds the cap', async () => {
    const { readFileSync } = await import('fs')
    vi.mocked(readFileSync).mockReturnValueOnce('x'.repeat(70_000))
    const s = sink()
    const res = await runReview('c1', 'x', 'code', 'src', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    expect(res).toEqual({ paused: false, failed: true })
    const evs = emitted(s)
    expect(evs.some((e) => e.type === 'error' && /too large/i.test((e as any).message))).toBe(true)
    expect(evs.some((e) => e.type === 'error' && /nothing to review/i.test((e as any).message))).toBe(false)
  })

  it('tells the user to open a folder when no workspace is set (not "nothing in <scope>")', async () => {
    const { getConversationMeta } = await import('../db')
    vi.mocked(getConversationMeta).mockReturnValueOnce({ id: 'c1', title: 't', projectPath: null } as never)
    const s = sink()
    const res = await runReview('c1', 'x', 'code', 'everything', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    expect(res).toEqual({ paused: false, failed: true })
    const err = emitted(s).find((e) => e.type === 'error') as any
    expect(err.message).toMatch(/open a project folder/i)
  })

  it('maps a whole-project scope ("everything") to the workspace instead of a literal path', async () => {
    const { makeModel } = await import('./models')
    vi.mocked(makeModel).mockImplementation(panelModels(
      { 'anthropic/claude-fable-5': [], 'openai/gpt-5.6-sol': [], 'xai/grok-4.5': [] },
      []
    ) as never)
    const { readdirSync, statSync } = await import('fs')
    // Root now lists a real file so the whole-project walk finds content.
    vi.mocked(readdirSync).mockImplementation(((dir: string) => (dir === '/project' ? ['a.ts'] : [])) as never)
    vi.mocked(statSync).mockImplementation(((p: string) => ({
      isDirectory: () => p === '/project',
      isFile: () => p !== '/project'
    })) as never)
    const s = sink()
    const res = await runReview('c1', 'x', 'code', 'everything', s as never, new AbortController().signal, URSA_REVIEW_PANEL)
    // "everything" resolved to files and ran the panel -- NOT a "couldn't find" error.
    expect(res).toEqual({ paused: false })
    expect(emitted(s).some((e) => e.type === 'error')).toBe(false)
    expect(emitted(s).some((e) => e.type === 'review_summary')).toBe(true)
  })
})
