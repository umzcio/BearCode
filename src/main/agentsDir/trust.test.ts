import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadAgentsContent, hasProjectAgentsConfig } from './index'

let projectDir: string, homeDir: string
const pRules = (): string => join(projectDir, '.agents', 'rules')
const gRules = (): string => join(homeDir, '.bearcode', 'agents', 'rules')
const pWorkflows = (): string => join(projectDir, '.agents', 'workflows')
const gWorkflows = (): string => join(homeDir, '.bearcode', 'agents', 'workflows')
const pSkills = (): string => join(projectDir, '.agents', 'skills')
const gSkills = (): string => join(homeDir, '.bearcode', 'agents', 'skills')
function write(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), body)
}
function writeSkill(dir: string, name: string, body: string): void {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), body)
}
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bc-trust-proj-'))
  homeDir = mkdtempSync(join(tmpdir(), 'bc-trust-home-'))
  vi.stubEnv('HOME', homeDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

describe('loadAgentsContent trust gate', () => {
  it('drops ALL project rules when trusted is omitted (secure default)', () => {
    write(pRules(), 'proj-rule', 'project body')
    write(gRules(), 'glob-rule', 'global body')
    const content = loadAgentsContent(projectDir) // no opts -> untrusted
    expect(content.rules.map((r) => r.name)).toEqual(['glob-rule'])
  })
  it('drops project rules when trusted:false, loads global', () => {
    write(pRules(), 'proj-rule', 'project body')
    write(gRules(), 'glob-rule', 'global body')
    const content = loadAgentsContent(projectDir, { trusted: false })
    expect(content.rules.some((r) => r.source === 'project')).toBe(false)
    expect(content.rules.some((r) => r.name === 'glob-rule')).toBe(true)
  })
  it('loads project rules when trusted:true', () => {
    write(pRules(), 'proj-rule', 'project body')
    const content = loadAgentsContent(projectDir, { trusted: true })
    expect(content.rules.find((r) => r.name === 'proj-rule')?.source).toBe('project')
  })

  it('drops project workflows when untrusted, loads global', () => {
    write(pWorkflows(), 'proj-flow', '1. step')
    write(gWorkflows(), 'glob-flow', '1. step')
    const content = loadAgentsContent(projectDir)
    expect(content.workflows.some((w) => w.source === 'project')).toBe(false)
    expect(content.workflows.some((w) => w.name === 'glob-flow')).toBe(true)
  })
  it('loads project workflows when trusted:true', () => {
    write(pWorkflows(), 'proj-flow', '1. step')
    const content = loadAgentsContent(projectDir, { trusted: true })
    expect(content.workflows.find((w) => w.name === 'proj-flow')?.source).toBe('project')
  })

  it('drops project skills when untrusted, loads global', () => {
    writeSkill(pSkills(), 'proj-skill', '---\ndescription: Proj skill.\n---\nbody')
    writeSkill(gSkills(), 'glob-skill', '---\ndescription: Global skill.\n---\nbody')
    const content = loadAgentsContent(projectDir)
    expect(content.skills.some((s) => s.source === 'project')).toBe(false)
    expect(content.skills.some((s) => s.name === 'glob-skill')).toBe(true)
  })
  it('loads project skills when trusted:true', () => {
    writeSkill(pSkills(), 'proj-skill', '---\ndescription: Proj skill.\n---\nbody')
    const content = loadAgentsContent(projectDir, { trusted: true })
    expect(content.skills.find((s) => s.name === 'proj-skill')?.source).toBe('project')
  })
})

describe('hasProjectAgentsConfig', () => {
  it('returns false when there is no .agents dir', () => {
    expect(hasProjectAgentsConfig(projectDir)).toBe(false)
  })
  it('returns false for a null path', () => {
    expect(hasProjectAgentsConfig(null)).toBe(false)
  })
  it('returns true after writing .agents/rules/x.md', () => {
    write(pRules(), 'x', 'body')
    expect(hasProjectAgentsConfig(projectDir)).toBe(true)
  })
})
