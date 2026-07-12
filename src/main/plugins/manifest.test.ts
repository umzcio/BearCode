import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
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
    expect(m.skills).toEqual([{ name: 'hello', description: 'Say hi' }])
    expect(m.rules).toEqual([{ name: 'style', activation: 'always' }])
    expect(m.servers).toEqual([{ name: 'db', transport: 'stdio', command: 'npx' }])
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
