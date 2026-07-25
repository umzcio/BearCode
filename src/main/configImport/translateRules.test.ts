import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRuleCandidate } from './translateRules'

describe('buildRuleCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-rules-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a kebab-case name from the source filename', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toMatchObject({ sourcePath: 'CLAUDE.md', suggestedName: 'claude', body: 'Always use tabs.' })
  })

  it('derives a name for a nested rule file', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.md'), 'Use vitest.')
    const c = buildRuleCandidate(dir, {
      sourcePath: join('.cursor', 'rules', 'testing.md'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(c?.suggestedName).toBe('testing')
  })

  it('resolves @path references using the shared rule-ref resolver', () => {
    writeFileSync(join(dir, 'shared.md'), 'Shared conventions.')
    writeFileSync(join(dir, 'CLAUDE.md'), 'See @shared.md for conventions.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c?.body).toContain('Shared conventions.')
    expect(c?.warnings).toEqual([])
  })

  it('returns null for a missing file', () => {
    const c = buildRuleCandidate(dir, { sourcePath: 'MISSING.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toBeNull()
  })

  it('returns null for an empty/whitespace-only file', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n  ')
    const c = buildRuleCandidate(dir, { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' })
    expect(c).toBeNull()
  })

  it('strips a .mdc extension when deriving the name (Cursor MDC rules)', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.mdc'), 'Use vitest.')
    const c = buildRuleCandidate(dir, {
      sourcePath: join('.cursor', 'rules', 'testing.mdc'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(c?.suggestedName).toBe('testing')
  })
})

// Final whole-branch review, Finding 1: import-time inlining of an ABSOLUTE
// out-of-workspace `@ref` must go through the SAME outside-of-folder consent
// gate the live loader applies to project rules (agentsDir's resolveRefPath).
// Inlining here is one-shot and irreversible -- the `@` token is gone from the
// written file -- so an ungated inline could never be re-evaluated later.
describe('buildRuleCandidate outside-of-folder policy', () => {
  let dir: string
  let outsideDir: string
  let outsideFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-outside-proj-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-import-outside-other-'))
    outsideFile = join(outsideDir, 'secret.md')
    writeFileSync(outsideFile, 'OUTSIDE SECRET.')
    writeFileSync(join(dir, 'CLAUDE.md'), `Follow @${outsideFile} closely.`)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  const source = { sourcePath: 'CLAUDE.md', kind: 'rule' as const, tool: 'claude-code' as const }

  it("drops the ref and records it pending under the default 'ask' policy", () => {
    const c = buildRuleCandidate(dir, source, { policy: 'ask', allowed: [], denied: [] })
    expect(c?.body).not.toContain('OUTSIDE SECRET.')
    expect(c?.body).toContain(`@${outsideFile}`) // literal token preserved
    expect(c?.warnings.join(' ')).toContain('Could not resolve rule reference')
    expect(c?.pendingOutside).toEqual([outsideFile])
  })

  it("inlines the ref under an 'allow' policy", () => {
    const c = buildRuleCandidate(dir, source, { policy: 'allow', allowed: [], denied: [] })
    expect(c?.body).toContain('OUTSIDE SECRET.')
    expect(c?.pendingOutside).toEqual([])
  })

  it("drops the ref WITHOUT recording it pending under a 'deny' policy", () => {
    const c = buildRuleCandidate(dir, source, { policy: 'deny', allowed: [], denied: [] })
    expect(c?.body).not.toContain('OUTSIDE SECRET.')
    expect(c?.pendingOutside).toEqual([])
  })

  it("inlines an already-allowed path under 'ask', and never re-records it", () => {
    const c = buildRuleCandidate(dir, source, {
      policy: 'ask',
      allowed: [outsideFile],
      denied: []
    })
    expect(c?.body).toContain('OUTSIDE SECRET.')
    expect(c?.pendingOutside).toEqual([])
  })

  it("drops an already-denied path under 'ask' without re-recording it", () => {
    const c = buildRuleCandidate(dir, source, {
      policy: 'ask',
      allowed: [],
      denied: [outsideFile]
    })
    expect(c?.body).not.toContain('OUTSIDE SECRET.')
    expect(c?.pendingOutside).toEqual([])
  })

  it('always resolves an IN-workspace absolute ref regardless of policy', () => {
    writeFileSync(join(dir, 'inside.md'), 'INSIDE CONTENT.')
    // Note the space after the token: the ref pattern is `@(\S+)`, so a
    // trailing period would be swallowed into the path.
    writeFileSync(join(dir, 'AGENTS.md'), `See @${join(dir, 'inside.md')} for details.`)
    const c = buildRuleCandidate(
      dir,
      { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' },
      { policy: 'deny', allowed: [], denied: [] }
    )
    expect(c?.body).toContain('INSIDE CONTENT.')
    expect(c?.pendingOutside).toEqual([])
  })

  // Documents WHY every real call site must pass a policy: with none, the
  // resolver falls back to the legacy allow-everything branch (kept only for
  // global rules, which have no project folder to be "outside" of).
  it('falls back to legacy allow-everything when no policy is supplied', () => {
    const c = buildRuleCandidate(dir, source)
    expect(c?.body).toContain('OUTSIDE SECRET.')
  })
})
