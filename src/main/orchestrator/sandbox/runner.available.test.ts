import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSync = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))

describe('SeatbeltRunner.available memoization', () => {
  beforeEach(() => {
    execFileSync.mockReset()
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
  })

  it('probes the binary at most once across repeated calls', async () => {
    const { SeatbeltRunner } = await import('./runner')
    const r = new SeatbeltRunner()
    expect(r.available()).toBe(true)
    expect(r.available()).toBe(true)
    expect(r.available()).toBe(true)
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })
})
