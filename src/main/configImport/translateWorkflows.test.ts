import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkflowCandidate } from './translateWorkflows'

describe('buildWorkflowCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-workflows-'))
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a kebab-case workflow name from the command filename', () => {
    writeFileSync(join(dir, '.claude', 'commands', 'deploy.md'), '1. Run the deploy script.')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'deploy.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toMatchObject({ suggestedName: 'deploy', body: '1. Run the deploy script.' })
  })

  it('returns null for a name that cannot be made kebab-case-valid', () => {
    writeFileSync(join(dir, '.claude', 'commands', '__.md'), 'body')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', '__.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null for an empty command file', () => {
    writeFileSync(join(dir, '.claude', 'commands', 'empty.md'), '')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'empty.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null for a missing file', () => {
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'missing.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })
})
