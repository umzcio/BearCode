import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePluginDir } from './manifest'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'bc-plug-'))
  const p = join(root, 'demo')
  mkdirSync(join(p, 'skills', 'hello'), { recursive: true })
  mkdirSync(join(p, 'rules'), { recursive: true })
  writeFileSync(join(p, 'plugin.json'), JSON.stringify({ description: 'A demo', version: '1.0.0' }))
  writeFileSync(
    join(p, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Say hi\n---\nbody'
  )
  writeFileSync(
    join(p, 'rules', 'style.md'),
    '---\nactivation: always\ndescription: style\n---\nrule'
  )
  writeFileSync(
    join(p, 'mcp.json'),
    JSON.stringify({ mcpServers: { db: { type: 'stdio', command: 'npx', args: ['-y', 'pg'] } } })
  )
  writeFileSync(join(p, 'hooks.json'), JSON.stringify({ h1: {}, h2: {} }))
  return p
}

describe('parsePluginDir', () => {
  it('parses a full plugin into a manifest, name defaults to dir', () => {
    const m = parsePluginDir(scaffold(), 'global')!
    expect(m.name).toBe('demo')
    expect(m.description).toBe('A demo')
    expect(m.version).toBe('1.0.0')
    expect(m.skills).toEqual([{ name: 'hello', description: 'Say hi', folder: 'hello' }])
    expect(m.rules).toEqual([{ name: 'style', activation: 'always' }])
    // Minor whole-branch finding: PluginServerSummary carried only `command`,
    // so a stdio server's args were dropped before ever reaching the install
    // review card -- npx -y pg looked identical to a bare, argless npx.
    expect(m.servers).toEqual([
      { name: 'db', transport: 'stdio', command: 'npx', args: ['-y', 'pg'] }
    ])
    expect(m.hookCount).toBe(2)
    expect(m.scope).toBe('global')
  })
  it('returns null when plugin.json is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'bc-plug-'))
    mkdirSync(join(root, 'nope'), { recursive: true })
    expect(parsePluginDir(join(root, 'nope'), 'global')).toBeNull()
  })
  it('returns a manifest even when plugin.json is malformed (name from dir, empty parts)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bc-plug-'))
    const p = join(root, 'broken')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{ not json')
    const m = parsePluginDir(p, 'project')!
    expect(m.name).toBe('broken')
    expect(m.skills).toEqual([])
    expect(m.hookCount).toBe(0)
  })
})

describe('parsePluginDir symlink containment (root supplied)', () => {
  it('excludes a symlinked rules directory pointing outside the project root', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'bc-plug-proj-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-plug-outside-'))
    try {
      const pluginDir = join(projectRoot, '.agents', 'plugins', 'demo')
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ description: 'demo' }))
      writeFileSync(
        join(outsideDir, 'secret.md'),
        '---\nactivation: always\ndescription: leak\n---\nSECRET RULE CONTENT'
      )
      symlinkSync(outsideDir, join(pluginDir, 'rules'))

      const m = parsePluginDir(pluginDir, 'project', projectRoot)!

      expect(m.rules).toEqual([])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('excludes a plugin SKILL.md whose leaf symlinks outside the project root', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'bc-plug-proj-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-plug-outside-'))
    try {
      const pluginDir = join(projectRoot, '.agents', 'plugins', 'demo')
      const evilSkillDir = join(pluginDir, 'skills', 'evil')
      mkdirSync(evilSkillDir, { recursive: true })
      writeFileSync(join(pluginDir, 'plugin.json'), '{}')
      const outsideSkillMd = join(outsideDir, 'SKILL.md')
      writeFileSync(
        outsideSkillMd,
        '---\nname: evil\ndescription: leak\n---\nSECRET SKILL CONTENT'
      )
      symlinkSync(outsideSkillMd, join(evilSkillDir, 'SKILL.md'))

      const m = parsePluginDir(pluginDir, 'project', projectRoot)!

      expect(m.skills).toEqual([])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('with no root supplied (global scope), still follows symlinks (backward-compat)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bc-plug-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-plug-outside-'))
    try {
      const pluginDir = join(root, 'demo')
      mkdirSync(join(pluginDir, 'rules'), { recursive: true })
      writeFileSync(join(pluginDir, 'plugin.json'), '{}')
      writeFileSync(
        join(outsideDir, 'legit.md'),
        '---\nactivation: always\ndescription: fine\n---\nbody'
      )
      symlinkSync(join(outsideDir, 'legit.md'), join(pluginDir, 'rules', 'legit.md'))

      const m = parsePluginDir(pluginDir, 'global')! // no root argument

      expect(m.rules).toEqual([{ name: 'legit', activation: 'always' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
