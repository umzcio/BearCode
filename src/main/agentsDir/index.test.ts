import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { loadAgentsContent, resolveRuleRefs } from './index'

let projectDir: string
let homeDir: string

function writeRule(dir: string, name: string, contents: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${name}.md`)
  writeFileSync(p, contents)
  return p
}

function projectRulesDir(): string {
  return join(projectDir, '.agents', 'rules')
}

function globalRulesDir(): string {
  return join(homeDir, '.bearcode', 'agents', 'rules')
}

function writeWorkflow(dir: string, name: string, contents: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${name}.md`)
  writeFileSync(p, contents)
  return p
}

function projectWorkflowsDir(): string {
  return join(projectDir, '.agents', 'workflows')
}

function globalWorkflowsDir(): string {
  return join(homeDir, '.bearcode', 'agents', 'workflows')
}

function writeSkill(dir: string, name: string, contents: string): string {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  const p = join(skillDir, 'SKILL.md')
  writeFileSync(p, contents)
  return p
}

function projectSkillsDir(): string {
  return join(projectDir, '.agents', 'skills')
}

function globalSkillsDirForTest(): string {
  return join(homeDir, '.bearcode', 'agents', 'skills')
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bearcode-agentsdir-project-'))
  homeDir = mkdtempSync(join(tmpdir(), 'bearcode-agentsdir-home-'))
  // homedir() (node:os) reads process.env.HOME on POSIX; stub it per-test so
  // the global-rules-dir merge test never touches the developer's real
  // ~/.bearcode, and restore it afterward so no other test/process sees the
  // (about to be deleted) tmp HOME.
  vi.stubEnv('HOME', homeDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

describe('loadAgentsContent', () => {
  it('merges project and global rules, project wins on filename collision', () => {
    writeRule(projectRulesDir(), 'shared', '# project version\nproject body')
    writeRule(globalRulesDir(), 'shared', '# global version\nglobal body')
    writeRule(globalRulesDir(), 'only-global', 'global only body')

    const content = loadAgentsContent(projectDir, { trusted: true })

    expect(content.rules).toHaveLength(2)
    const shared = content.rules.find((r) => r.name === 'shared')
    expect(shared?.source).toBe('project')
    expect(shared?.body).toContain('project body')
    const globalOnly = content.rules.find((r) => r.name === 'only-global')
    expect(globalOnly?.source).toBe('global')
  })

  it('returns an empty rule and workflow list when all directories are missing', () => {
    const content = loadAgentsContent(projectDir, { trusted: true })
    expect(content).toEqual({ rules: [], workflows: [], skills: [], pendingOutside: [] })
  })

  it('returns the same Rule object across two loads when nothing changed', () => {
    writeRule(projectRulesDir(), 'stable', 'stable body')

    const first = loadAgentsContent(projectDir, { trusted: true })
    const second = loadAgentsContent(projectDir, { trusted: true })

    const firstRule = first.rules.find((r) => r.name === 'stable')
    const secondRule = second.rules.find((r) => r.name === 'stable')
    expect(firstRule).toBeDefined()
    expect(firstRule).toBe(secondRule)
  })

  it('re-parses a file whose mtime and content changed', () => {
    const path = writeRule(projectRulesDir(), 'changing', 'original body')
    const first = loadAgentsContent(projectDir, { trusted: true })
    const firstRule = first.rules.find((r) => r.name === 'changing')

    writeFileSync(path, 'updated body')
    const future = new Date(Date.now() + 5000)
    utimesSync(path, future, future)

    const second = loadAgentsContent(projectDir, { trusted: true })
    const secondRule = second.rules.find((r) => r.name === 'changing')

    expect(secondRule).not.toBe(firstRule)
    expect(secondRule?.body).toContain('updated body')
    expect(secondRule?.body).not.toContain('original body')
  })

  it('inlines a project-relative @path cross-reference', () => {
    writeRule(projectRulesDir(), 'main', 'See @shared/snippet.md for details.')
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'snippet.md'), 'THE SNIPPET CONTENT')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('THE SNIPPET CONTENT')
    expect(rule?.warnings ?? []).toEqual([])
  })

  it('inlines an absolute-path cross-reference outside the project', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-agentsdir-outside-'))
    try {
      const outsideFile = join(outsideDir, 'external.md')
      writeFileSync(outsideFile, 'EXTERNAL FILE CONTENT')
      writeRule(projectRulesDir(), 'main', `See @${outsideFile} for details.`)

      const content = loadAgentsContent(projectDir, { trusted: true })
      const rule = content.rules.find((r) => r.name === 'main')

      expect(rule?.body).toContain('EXTERNAL FILE CONTENT')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('caps an inlined reference at 64KB', () => {
    const big = 'x'.repeat(70 * 1024)
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'big.md'), big)
    writeRule(projectRulesDir(), 'main', 'See @shared/big.md for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    // Extract just the inlined block's content (between the fence markers),
    // not the whole rule body, since the fence header embeds the resolved
    // tmp-dir path which can itself contain stray 'x' characters.
    const inlined = /--- begin @shared\/big\.md \([^)]*\) ---\n([\s\S]*?)\n--- end/.exec(
      rule?.body ?? ''
    )
    expect(inlined).not.toBeNull()
    const inlinedContent = inlined?.[1] ?? ''
    expect(inlinedContent.length).toBeLessThanOrEqual(64 * 1024)
    expect(inlinedContent.length).toBeGreaterThan(0)
    expect(inlinedContent).toBe('x'.repeat(64 * 1024))
  })

  it('detects a reference cycle and leaves the repeat as a literal token with a warning', () => {
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    // Relative refs resolve against the workspace root (projectDir), not the
    // referencing file's own directory (design 2), so b.md points back at the
    // rule file's path relative to the project root to close the cycle.
    writeFileSync(
      join(projectDir, 'shared', 'b.md'),
      'B content references @.agents/rules/a-ref.md back'
    )
    writeRule(projectRulesDir(), 'a-ref', 'A content references @shared/b.md')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'a-ref')

    expect(rule).toBeDefined()
    // The cycle must not hang; the repeated inclusion stays literal.
    expect(rule?.body).toContain('@.agents/rules/a-ref.md')
    expect(rule?.warnings?.some((w) => /cycle/i.test(w))).toBe(true)
  })

  it('does not resolve a relative reference that escapes the workspace', () => {
    // The sibling actually exists and is readable on disk (real secret
    // content) -- the assertion is that the containment check rejects it
    // purely on path grounds, not that the read happens to fail.
    writeFileSync(join(projectDir, '..', 'secret.md'), 'TOP SECRET')
    try {
      writeRule(projectRulesDir(), 'main', 'See @../secret.md for details.')

      const content = loadAgentsContent(projectDir, { trusted: true })
      const rule = content.rules.find((r) => r.name === 'main')

      expect(rule?.body).toContain('@../secret.md')
      expect(rule?.body).not.toContain('TOP SECRET')
      expect(rule?.warnings?.length ?? 0).toBeGreaterThan(0)
    } finally {
      rmSync(join(projectDir, '..', 'secret.md'), { force: true })
    }
  })

  it('does not misclassify a sibling directory that shares a string prefix with the root', () => {
    // Boundary check regression: root ".../project" must not treat
    // ".../project-evil/secret.md" as inside the workspace just because it
    // shares a textual prefix with root (a naive startsWith(root) would).
    const evilDir = `${projectDir}-evil`
    mkdirSync(evilDir, { recursive: true })
    try {
      writeFileSync(join(evilDir, 'secret.md'), 'PREFIX BYPASS SECRET')
      const evilRelative = `../${evilDir.slice(evilDir.lastIndexOf(sep) + 1)}/secret.md`
      writeRule(projectRulesDir(), 'main', `See @${evilRelative} for details.`)

      const content = loadAgentsContent(projectDir, { trusted: true })
      const rule = content.rules.find((r) => r.name === 'main')

      expect(rule?.body).toContain(`@${evilRelative}`)
      expect(rule?.body).not.toContain('PREFIX BYPASS SECRET')
    } finally {
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  it('leaves an unresolvable reference literal with a warning', () => {
    writeRule(projectRulesDir(), 'main', 'See @shared/missing.md for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('@shared/missing.md')
    expect(rule?.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('reads at most 64KB from a very large file instead of loading it whole', () => {
    // A 32MB sparse file: only the read path is exercised, no real disk cost.
    // The point of this test is the BOUNDED read (stat-gated, fixed buffer):
    // if the implementation regressed to a whole-file readFileSync followed
    // by a slice, this still passes functionally, but the fixed-buffer read
    // is what prevents a multi-GB or /dev/zero-style target from ever being
    // materialized in memory; the FIFO test below is the behavioral gate for
    // the never-open-non-regular-files half of that guarantee.
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    const sparsePath = join(projectDir, 'shared', 'huge.md')
    const fd = openSync(sparsePath, 'w')
    ftruncateSync(fd, 32 * 1024 * 1024)
    closeSync(fd)
    writeRule(projectRulesDir(), 'main', 'See @shared/huge.md for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    const inlined = /--- begin @shared\/huge\.md \([^)]*\) ---\n([\s\S]*?)\n--- end/.exec(
      rule?.body ?? ''
    )
    expect(inlined).not.toBeNull()
    expect((inlined?.[1] ?? '').length).toBeLessThanOrEqual(64 * 1024)
  })

  it('rejects a reference to a non-regular file (directory) as unresolvable', () => {
    mkdirSync(join(projectDir, 'shared', 'a-directory'), { recursive: true })
    writeRule(projectRulesDir(), 'main', 'See @shared/a-directory for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('@shared/a-directory')
    expect(rule?.body).not.toContain('--- begin')
    expect(rule?.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('rejects a reference to a FIFO without opening (and thus without blocking on) it', () => {
    // A FIFO with no writer blocks any reader that OPENS it -- the stat-first
    // isFile() gate must reject it before any open/read happens. If the gate
    // regressed to open-then-read, this test would hang and time out.
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    const fifoPath = join(projectDir, 'shared', 'pipe.md')
    execFileSync('mkfifo', [fifoPath])
    writeRule(projectRulesDir(), 'main', 'See @shared/pipe.md for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('@shared/pipe.md')
    expect(rule?.body).not.toContain('--- begin')
    expect(rule?.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('inlines each file at most once per rule (diamond ref tree) and leaves repeats literal', () => {
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'd.md'), 'D-CONTENT')
    writeFileSync(join(projectDir, 'shared', 'b.md'), 'B-CONTENT then @shared/d.md')
    writeFileSync(join(projectDir, 'shared', 'c.md'), 'C-CONTENT then @shared/d.md')
    writeRule(projectRulesDir(), 'main', 'Top: @shared/b.md and @shared/c.md')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('B-CONTENT')
    expect(rule?.body).toContain('C-CONTENT')
    // d.md is inlined exactly once (under b.md); the second occurrence (under
    // c.md) stays a literal token with a dedupe warning, which is what keeps
    // total work linear in distinct files instead of k^depth for branching
    // ref trees.
    expect((rule?.body.match(/D-CONTENT/g) ?? []).length).toBe(1)
    expect(rule?.warnings?.some((w) => /already included/i.test(w))).toBe(true)
  })

  it('caps total inclusions per rule and leaves the remainder literal with a warning', () => {
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    const total = 70
    const tokens: string[] = []
    for (let i = 0; i < total; i++) {
      writeFileSync(join(projectDir, 'shared', `f${i}.md`), `CONTENT-OF-${i}`)
      tokens.push(`@shared/f${i}.md`)
    }
    writeRule(projectRulesDir(), 'main', tokens.join('\n'))

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    const inlinedCount = (rule?.body.match(/--- begin /g) ?? []).length
    expect(inlinedCount).toBe(64)
    expect(rule?.warnings?.some((w) => /inclusion limit/i.test(w))).toBe(true)
    expect(rule?.warnings?.filter((w) => /inclusion limit/i.test(w)).length).toBe(total - 64)
  })

  it('truncates an oversized rule file itself and records a warning', () => {
    writeRule(projectRulesDir(), 'huge-rule', 'y'.repeat(100 * 1024))

    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'huge-rule')

    expect(rule).toBeDefined()
    expect(rule?.body.length).toBeLessThanOrEqual(64 * 1024)
    expect(rule?.warnings?.some((w) => /truncated/i.test(w))).toBe(true)
  })

  it('resolves a global rule relative ref per project, not from another project cache entry', () => {
    // The same global rule file, unchanged on disk, loaded under two
    // different projectPaths: its relative cross-ref must resolve against
    // whichever project is current, proving the cache key includes the
    // projectPath and a stale other-project resolution is never served.
    writeRule(globalRulesDir(), 'shared-global', 'Ref: @shared/marker.md')
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'marker.md'), 'ALPHA-PROJECT-CONTENT')

    const otherProject = mkdtempSync(join(tmpdir(), 'bearcode-agentsdir-project2-'))
    try {
      mkdirSync(join(otherProject, 'shared'), { recursive: true })
      writeFileSync(join(otherProject, 'shared', 'marker.md'), 'BETA-PROJECT-CONTENT')

      const first = loadAgentsContent(projectDir, { trusted: true })
      const firstRule = first.rules.find((r) => r.name === 'shared-global')
      expect(firstRule?.body).toContain('ALPHA-PROJECT-CONTENT')

      const second = loadAgentsContent(otherProject)
      const secondRule = second.rules.find((r) => r.name === 'shared-global')
      expect(secondRule?.body).toContain('BETA-PROJECT-CONTENT')
      expect(secondRule?.body).not.toContain('ALPHA-PROJECT-CONTENT')
    } finally {
      rmSync(otherProject, { recursive: true, force: true })
    }
  })

  it('bounds a long non-cyclic reference chain with a max-depth guard instead of overflowing', () => {
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    const chainLength = 200
    for (let i = 0; i < chainLength; i++) {
      const next = i + 1 < chainLength ? `@shared/link-${i + 1}.md ` : 'end of chain'
      writeFileSync(join(projectDir, 'shared', `link-${i}.md`), `link ${i} -> ${next}`)
    }
    writeRule(projectRulesDir(), 'main', 'See @shared/link-0.md for details.')

    // Must not throw/stack-overflow, and must terminate.
    const content = loadAgentsContent(projectDir, { trusted: true })
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule).toBeDefined()
    expect(rule?.warnings?.some((w) => /max reference depth/i.test(w))).toBe(true)
  })
})

describe('loadAgentsContent workflows', () => {
  it('reads both project and global workflow directories', () => {
    writeWorkflow(projectWorkflowsDir(), 'release-check', '1. Build\n2. Test')
    writeWorkflow(globalWorkflowsDir(), 'global-only', '1. Do the global thing')

    const content = loadAgentsContent(projectDir, { trusted: true })

    expect(content.workflows).toHaveLength(2)
    const releaseCheck = content.workflows.find((w) => w.name === 'release-check')
    expect(releaseCheck?.source).toBe('project')
    expect(releaseCheck?.steps).toEqual(['Build', 'Test'])
    const globalOnly = content.workflows.find((w) => w.name === 'global-only')
    expect(globalOnly?.source).toBe('global')
  })

  it('project wins on a workflow filename collision', () => {
    writeWorkflow(projectWorkflowsDir(), 'shared', '1. project version')
    writeWorkflow(globalWorkflowsDir(), 'shared', '1. global version')

    const content = loadAgentsContent(projectDir, { trusted: true })

    expect(content.workflows).toHaveLength(1)
    const shared = content.workflows.find((w) => w.name === 'shared')
    expect(shared?.source).toBe('project')
    expect(shared?.steps).toEqual(['project version'])
  })

  it('returns the same Workflow object across two loads when nothing changed', () => {
    writeWorkflow(projectWorkflowsDir(), 'stable', '1. stable step')

    const first = loadAgentsContent(projectDir, { trusted: true })
    const second = loadAgentsContent(projectDir, { trusted: true })

    const firstWorkflow = first.workflows.find((w) => w.name === 'stable')
    const secondWorkflow = second.workflows.find((w) => w.name === 'stable')
    expect(firstWorkflow).toBeDefined()
    expect(firstWorkflow).toBe(secondWorkflow)
  })

  it('re-parses a workflow file whose mtime and content changed', () => {
    const path = writeWorkflow(projectWorkflowsDir(), 'changing', '1. original step')
    const first = loadAgentsContent(projectDir, { trusted: true })
    const firstWorkflow = first.workflows.find((w) => w.name === 'changing')

    writeFileSync(path, '1. updated step')
    const future = new Date(Date.now() + 5000)
    utimesSync(path, future, future)

    const second = loadAgentsContent(projectDir, { trusted: true })
    const secondWorkflow = second.workflows.find((w) => w.name === 'changing')

    expect(secondWorkflow).not.toBe(firstWorkflow)
    expect(secondWorkflow?.steps).toEqual(['updated step'])
  })

  it('returns an empty workflow list when both workflow directories are missing', () => {
    const content = loadAgentsContent(projectDir, { trusted: true })
    expect(content.workflows).toEqual([])
  })

  it('never resolves @-cross-references in a workflow body', () => {
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'snippet.md'), 'THE SNIPPET CONTENT')
    writeWorkflow(projectWorkflowsDir(), 'main', 'See @shared/snippet.md for details.')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const workflow = content.workflows.find((w) => w.name === 'main')

    expect(workflow?.body).toContain('@shared/snippet.md')
    expect(workflow?.body).not.toContain('THE SNIPPET CONTENT')
  })

  it('truncates an oversized workflow file and records a warning', () => {
    writeWorkflow(projectWorkflowsDir(), 'huge-workflow', 'y'.repeat(100 * 1024))

    const content = loadAgentsContent(projectDir, { trusted: true })
    const workflow = content.workflows.find((w) => w.name === 'huge-workflow')

    expect(workflow).toBeDefined()
    expect(workflow?.body.length).toBeLessThanOrEqual(64 * 1024)
    expect(workflow?.warnings?.some((w) => /truncated/i.test(w))).toBe(true)
  })

  it('keeps a malformed workflow file listed with its error, never throwing', () => {
    writeWorkflow(projectWorkflowsDir(), 'broken', '---\ndescription: broken\nno closer here')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const workflow = content.workflows.find((w) => w.name === 'broken')

    expect(workflow).toBeDefined()
    expect(workflow?.error).toBeTruthy()
  })
})

describe('loadAgentsContent skills', () => {
  it('loads project skills from .agents/skills/<name>/SKILL.md', () => {
    writeSkill(projectSkillsDir(), 'alpha', '---\ndescription: Alpha does A.\n---\nbody a')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const alpha = content.skills.find((s) => s.name === 'alpha')

    expect(alpha?.description).toBe('Alpha does A.')
    expect(alpha?.source).toBe('project')
  })

  it('project skill overrides a same-named global skill', () => {
    writeSkill(
      globalSkillsDirForTest(),
      'alpha',
      '---\ndescription: Global alpha.\n---\nglobal body'
    )
    writeSkill(projectSkillsDir(), 'alpha', '---\ndescription: Project alpha.\n---\nproject body')

    const content = loadAgentsContent(projectDir, { trusted: true })
    const alphas = content.skills.filter((s) => s.name === 'alpha')

    expect(alphas).toHaveLength(1)
    expect(alphas[0].source).toBe('project')
  })

  it('ignores a skill folder with no SKILL.md', () => {
    mkdirSync(join(projectSkillsDir(), 'empty-dir'), { recursive: true })

    const content = loadAgentsContent(projectDir, { trusted: true })

    expect(content.skills.find((s) => s.name === 'empty-dir')).toBeUndefined()
  })

  it('returns [] skills when no project is open but loads global skills', () => {
    writeSkill(globalSkillsDirForTest(), 'global-only', '---\ndescription: Global only.\n---\nbody')

    const content = loadAgentsContent(null)

    expect(content.skills.some((s) => s.source === 'global')).toBe(true)
  })

  it('returns the same Skill object across two loads when nothing changed', () => {
    writeSkill(projectSkillsDir(), 'stable', '---\ndescription: Stable skill.\n---\nstable body')

    const first = loadAgentsContent(projectDir, { trusted: true })
    const second = loadAgentsContent(projectDir, { trusted: true })

    const firstSkill = first.skills.find((s) => s.name === 'stable')
    const secondSkill = second.skills.find((s) => s.name === 'stable')
    expect(firstSkill).toBeDefined()
    expect(firstSkill).toBe(secondSkill)
  })

  it('re-parses a skill file whose mtime and content changed', () => {
    const path = writeSkill(
      projectSkillsDir(),
      'changing',
      '---\ndescription: Original.\n---\noriginal body'
    )
    const first = loadAgentsContent(projectDir, { trusted: true })
    const firstSkill = first.skills.find((s) => s.name === 'changing')

    writeFileSync(path, '---\ndescription: Updated.\n---\nupdated body')
    const future = new Date(Date.now() + 5000)
    utimesSync(path, future, future)

    const second = loadAgentsContent(projectDir, { trusted: true })
    const secondSkill = second.skills.find((s) => s.name === 'changing')

    expect(secondSkill).not.toBe(firstSkill)
    expect(secondSkill?.body.trim()).toBe('updated body')
  })

  it('truncates an oversized skill file and records a warning', () => {
    writeSkill(projectSkillsDir(), 'huge-skill', 'y'.repeat(100 * 1024))

    const content = loadAgentsContent(projectDir, { trusted: true })
    const skill = content.skills.find((s) => s.name === 'huge-skill')

    expect(skill).toBeDefined()
    expect(skill?.body.length).toBeLessThanOrEqual(64 * 1024)
    expect(skill?.warnings?.some((w) => /truncated/i.test(w))).toBe(true)
  })
})

describe('resolveRuleRefs', () => {
  it('leaves plain bodies with no @ tokens untouched', () => {
    const { body, warnings } = resolveRuleRefs('just some prose, no refs here', projectDir)
    expect(body).toBe('just some prose, no refs here')
    expect(warnings).toEqual([])
  })
})
