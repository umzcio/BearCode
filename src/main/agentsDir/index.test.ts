import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs'
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

    const content = loadAgentsContent(projectDir)

    expect(content.rules).toHaveLength(2)
    const shared = content.rules.find((r) => r.name === 'shared')
    expect(shared?.source).toBe('project')
    expect(shared?.body).toContain('project body')
    const globalOnly = content.rules.find((r) => r.name === 'only-global')
    expect(globalOnly?.source).toBe('global')
  })

  it('returns an empty rule list when both directories are missing', () => {
    const content = loadAgentsContent(projectDir)
    expect(content).toEqual({ rules: [] })
  })

  it('returns the same Rule object across two loads when nothing changed', () => {
    writeRule(projectRulesDir(), 'stable', 'stable body')

    const first = loadAgentsContent(projectDir)
    const second = loadAgentsContent(projectDir)

    const firstRule = first.rules.find((r) => r.name === 'stable')
    const secondRule = second.rules.find((r) => r.name === 'stable')
    expect(firstRule).toBeDefined()
    expect(firstRule).toBe(secondRule)
  })

  it('re-parses a file whose mtime and content changed', () => {
    const path = writeRule(projectRulesDir(), 'changing', 'original body')
    const first = loadAgentsContent(projectDir)
    const firstRule = first.rules.find((r) => r.name === 'changing')

    writeFileSync(path, 'updated body')
    const future = new Date(Date.now() + 5000)
    utimesSync(path, future, future)

    const second = loadAgentsContent(projectDir)
    const secondRule = second.rules.find((r) => r.name === 'changing')

    expect(secondRule).not.toBe(firstRule)
    expect(secondRule?.body).toContain('updated body')
    expect(secondRule?.body).not.toContain('original body')
  })

  it('inlines a project-relative @path cross-reference', () => {
    writeRule(projectRulesDir(), 'main', 'See @shared/snippet.md for details.')
    mkdirSync(join(projectDir, 'shared'), { recursive: true })
    writeFileSync(join(projectDir, 'shared', 'snippet.md'), 'THE SNIPPET CONTENT')

    const content = loadAgentsContent(projectDir)
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

      const content = loadAgentsContent(projectDir)
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

    const content = loadAgentsContent(projectDir)
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

    const content = loadAgentsContent(projectDir)
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

      const content = loadAgentsContent(projectDir)
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

      const content = loadAgentsContent(projectDir)
      const rule = content.rules.find((r) => r.name === 'main')

      expect(rule?.body).toContain(`@${evilRelative}`)
      expect(rule?.body).not.toContain('PREFIX BYPASS SECRET')
    } finally {
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  it('leaves an unresolvable reference literal with a warning', () => {
    writeRule(projectRulesDir(), 'main', 'See @shared/missing.md for details.')

    const content = loadAgentsContent(projectDir)
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule?.body).toContain('@shared/missing.md')
    expect(rule?.warnings?.length ?? 0).toBeGreaterThan(0)
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
    const content = loadAgentsContent(projectDir)
    const rule = content.rules.find((r) => r.name === 'main')

    expect(rule).toBeDefined()
    expect(rule?.warnings?.some((w) => /max reference depth/i.test(w))).toBe(true)
  })
})

describe('resolveRuleRefs', () => {
  it('leaves plain bodies with no @ tokens untouched', () => {
    const { body, warnings } = resolveRuleRefs('just some prose, no refs here', projectDir)
    expect(body).toBe('just some prose, no refs here')
    expect(warnings).toEqual([])
  })
})
