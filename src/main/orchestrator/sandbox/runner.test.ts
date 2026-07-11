import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('child_process', () => ({ execFileSync: vi.fn(() => '/usr/bin/sandbox-exec\n') }))

import { execFileSync } from 'child_process'
import { SeatbeltRunner } from './runner'
import type { SandboxPolicy } from './types'

const policy: SandboxPolicy = { writeRoots: ['/w'], readDenyPaths: ['/s'], allowNetwork: false }

function setPlatform(p: NodeJS.Platform): () => void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', orig)
}

describe('SeatbeltRunner', () => {
  afterEach(() => vi.restoreAllMocks())

  it('available() is false off darwin regardless of resolvability', () => {
    const restore = setPlatform('linux')
    expect(new SeatbeltRunner().available()).toBe(false)
    restore()
  })

  it('available() is true on darwin when sandbox-exec resolves', () => {
    const restore = setPlatform('darwin')
    expect(new SeatbeltRunner().available()).toBe(true)
    restore()
  })

  it('available() is false on darwin when sandbox-exec cannot be resolved', () => {
    const restore = setPlatform('darwin')
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })
    expect(new SeatbeltRunner().available()).toBe(false)
    restore()
  })

  it('wrap() returns sandbox-exec with an inline -p profile and login zsh', () => {
    const plan = new SeatbeltRunner().wrap('echo hi', '/w', policy)
    expect(plan.file).toBe('sandbox-exec')
    expect(plan.args[0]).toBe('-p')
    expect(plan.args[1]).toContain('(deny default)')
    expect(plan.args.slice(2)).toEqual(['/bin/zsh', '-lc', 'echo hi'])
  })

  it('wrap() env is scrubbed (no secret vars survive)', () => {
    const prev = process.env.MY_SECRET_TOKEN
    process.env.MY_SECRET_TOKEN = 'x'
    const plan = new SeatbeltRunner().wrap('echo hi', '/w', policy)
    expect(plan.env.MY_SECRET_TOKEN).toBeUndefined()
    expect(plan.env.PATH).toBeDefined()
    if (prev === undefined) delete process.env.MY_SECRET_TOKEN
    else process.env.MY_SECRET_TOKEN = prev
  })
})
