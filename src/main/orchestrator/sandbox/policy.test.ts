import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/z/Library/Application Support/BearCode' }
}))
vi.mock('os', async (orig) => ({
  ...(await orig<typeof import('os')>()),
  homedir: () => '/Users/z'
}))
import { buildSandboxPolicy } from './policy'

describe('buildSandboxPolicy', () => {
  it('write roots include the cwd and temp dirs', () => {
    const p = buildSandboxPolicy('/Users/z/proj', false)
    expect(p.writeRoots).toContain('/Users/z/proj')
    expect(p.writeRoots).toContain('/private/tmp')
    expect(p.writeRoots.some((w) => w.includes('/private/var/folders'))).toBe(true)
  })
  it('read-deny includes secret dirs and the vault', () => {
    const p = buildSandboxPolicy('/Users/z/proj', false)
    expect(p.readDenyPaths).toContain('/Users/z/.ssh')
    expect(p.readDenyPaths).toContain('/Users/z/.aws')
    expect(p.readDenyPaths).toContain('/Users/z/.config/gh')
    expect(p.readDenyPaths).toContain('/Users/z/.config/gcloud')
    expect(p.readDenyPaths).toContain('/Users/z/.gnupg')
    expect(p.readDenyPaths).toContain('/Users/z/.bearcode')
    expect(p.readDenyPaths).toContain('/Users/z/Library/Application Support/BearCode/keys.json')
  })
  it('passes allowNetwork through', () => {
    expect(buildSandboxPolicy('/x', true).allowNetwork).toBe(true)
    expect(buildSandboxPolicy('/x', false).allowNetwork).toBe(false)
  })
})
