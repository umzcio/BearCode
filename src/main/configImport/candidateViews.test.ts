// Final whole-branch review, Finding 6: the scan IPC handler used to return raw
// DetectedSources, so the review modal listed every detected path pre-checked
// and importable -- including ones that cannot translate at all, which then
// imported as 0 items with no explanation. buildCandidateViews attempts each
// translation up front so the modal can disable-with-a-reason, preview, and
// surface the translators' warnings instead of discarding them.
//
// No DB mock needed here: this module only calls the pure translators.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCandidateViews, previewOf } from './candidateViews'
import { scanImportableConfig } from './scan'

describe('previewOf', () => {
  it('collapses whitespace onto one line', () => {
    expect(previewOf('First line.\n\n  Second   line.\n')).toBe('First line. Second line.')
  })

  it('drops a leading frontmatter block so the preview shows real content', () => {
    expect(previewOf('---\ndescription: A thing\n---\nActual instructions.')).toBe(
      'Actual instructions.'
    )
  })

  it('truncates long text with an ellipsis', () => {
    const p = previewOf('x'.repeat(400))
    expect(p.endsWith('…')).toBe(true)
    expect(p.length).toBeLessThanOrEqual(151)
  })

  it('returns an empty string for empty input', () => {
    expect(previewOf('')).toBe('')
  })
})

describe('buildCandidateViews', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-candidate-views-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const viewFor = (sourcePath: string): ReturnType<typeof buildCandidateViews>[number] => {
    const views = buildCandidateViews(dir, scanImportableConfig(dir), {
      policy: 'ask',
      allowed: [],
      denied: []
    })
    const v = views.find((x) => x.sourcePath === sourcePath)
    if (!v) throw new Error(`no view for ${sourcePath}`)
    return v
  }

  it('marks a translatable rule buildable and previews its body', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'You are working on a Next.js app. Always use tabs.')
    expect(viewFor('CLAUDE.md')).toEqual({
      sourcePath: 'CLAUDE.md',
      kind: 'rule',
      tool: 'claude-code',
      buildable: true,
      preview: 'You are working on a Next.js app. Always use tabs.'
    })
  })

  it('marks an EMPTY instruction file not buildable (was: silently imported as 0)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n\n  ')
    const v = viewFor('AGENTS.md')
    expect(v.buildable).toBe(false)
    expect(v.preview).toBeUndefined()
  })

  it('marks a command file whose name cannot be kebab-cased not buildable', () => {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', '__.md'), 'body')
    expect(viewFor(join('.claude', 'commands', '__.md')).buildable).toBe(false)
  })

  it('marks a SKILL.md missing its required description not buildable', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'broken', 'SKILL.md'), 'Just a body, no frontmatter.')
    expect(viewFor(join('.claude', 'skills', 'broken')).buildable).toBe(false)
  })

  it('previews a valid skill with its description', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody.'
    )
    const v = viewFor(join('.claude', 'skills', 'pdf-export'))
    expect(v).toMatchObject({ buildable: true, preview: 'Export docs to PDF' })
  })

  it('surfaces the translator warnings instead of discarding them', () => {
    // `@` is common in real prose, so an unresolvable ref is routine -- the
    // user needs to see that the token was left literal.
    writeFileSync(join(dir, 'CLAUDE.md'), 'Install @anthropic-ai/sdk first.')
    const v = viewFor('CLAUDE.md')
    expect(v.buildable).toBe(true)
    expect(v.warnings?.join(' ')).toContain('Could not resolve rule reference')
  })

  it('omits warnings entirely when there are none', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Plain instructions, no refs.')
    expect(viewFor('CLAUDE.md').warnings).toBeUndefined()
  })

  it('reports an unsupported kind as not buildable, with no preview attempt', () => {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'A subagent definition.')
    expect(viewFor(join('.claude', 'agents', 'reviewer.md'))).toEqual({
      sourcePath: join('.claude', 'agents', 'reviewer.md'),
      kind: 'unsupported',
      tool: 'claude-code',
      buildable: false
    })
  })

  it('caps the number of sources fully described per call (perf finding)', () => {
    // Fabricate more DetectedSources than MAX_PREVIEWED (200) directly --
    // scanImportableConfig has no size cap of its own, so a real repo with a
    // huge .cursor/rules/ tree could hand buildCandidateViews an arbitrarily
    // long list. Real files aren't needed since the ones past the cap must
    // never even be read.
    const detected = Array.from({ length: 250 }, (_, i) => ({
      sourcePath: `fake-${i}.md`,
      kind: 'rule' as const,
      tool: 'cursor' as const
    }))
    const views = buildCandidateViews(dir, detected, { policy: 'ask', allowed: [], denied: [] })

    expect(views).toHaveLength(250)
    const first200 = views.slice(0, 200)
    const rest = views.slice(200)

    // The first 200 were attempted (none of these files exist on disk, so the
    // translator fails to build them -- but genuinely, not because of the
    // cap: notPreviewed must be absent, not just falsy-but-present).
    for (const v of first200) {
      expect(v.buildable).toBe(false)
      expect(v.notPreviewed).toBeUndefined()
    }
    // Everything past the cap is still present (not silently dropped) and
    // marked with the distinct not-previewed reason -- never a false "couldn't
    // parse", since it was never attempted.
    for (const v of rest) {
      expect(v.buildable).toBe(false)
      expect(v.notPreviewed).toBe(true)
    }
  })

  it('does not spend the preview cap on unsupported sources', () => {
    // 'unsupported' sources already skip parsing for their own reason (not
    // yet a translatable kind) -- they must not eat into the budget meant for
    // kinds that actually attempt a parse.
    const detected = Array.from({ length: 200 }, (_, i) => ({
      sourcePath: `unsupported-${i}.md`,
      kind: 'unsupported' as const,
      tool: 'claude-code' as const
    }))
    detected.push({ sourcePath: 'CLAUDE.md', kind: 'rule' as const, tool: 'claude-code' as const })
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')

    const views = buildCandidateViews(dir, detected, { policy: 'ask', allowed: [], denied: [] })
    const ruleView = views.find((v) => v.sourcePath === 'CLAUDE.md')
    expect(ruleView?.buildable).toBe(true)
    expect(ruleView?.notPreviewed).toBeUndefined()
  })

  it('honors the outside-of-folder policy in the preview (Finding 1)', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-candidate-views-outside-'))
    const outsideFile = join(outsideDir, 'secret.md')
    writeFileSync(outsideFile, 'OUTSIDE SECRET.')
    writeFileSync(join(dir, 'CLAUDE.md'), `Follow @${outsideFile} closely.`)
    // Default 'ask' policy: the preview must not leak the out-of-folder content,
    // and must show the ref was left un-inlined (no `--- begin @` header).
    const asked = viewFor('CLAUDE.md')
    expect(asked.preview).not.toContain('OUTSIDE SECRET.')
    expect(asked.preview).not.toContain('--- begin @')
    expect(asked.warnings?.join(' ')).toContain('Could not resolve rule reference')
    // Under 'allow' the ref IS inlined. The tmpdir path alone is longer than the
    // 150-char preview window, so assert on the inline header, which appears
    // first, rather than on the inlined text itself.
    const allowed = buildCandidateViews(dir, scanImportableConfig(dir), {
      policy: 'allow',
      allowed: [],
      denied: []
    })
    expect(allowed[0].preview).toContain('--- begin @')
    expect(allowed[0].warnings).toBeUndefined()
    rmSync(outsideDir, { recursive: true, force: true })
  })
})
