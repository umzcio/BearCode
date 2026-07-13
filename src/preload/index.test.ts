import { describe, it, expect, vi } from 'vitest'

// index.ts calls contextBridge.exposeInMainWorld('bearcode', bearcode) at
// module load time. Mock 'electron' so we can capture the real bearcode
// object built by the preload script and spy on ipcRenderer.invoke, without
// an actual Electron runtime.
const invoke = vi.fn()
let exposed: Record<string, unknown> | undefined

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed = api
    }
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

describe('preload run.start mentions forwarding', () => {
  it('forwards mentions as the 6th ipcRenderer.invoke argument (MANDATORY correction)', async () => {
    await import('./index')
    expect(exposed).toBeDefined()
    const bearcode = exposed as unknown as {
      run: { start: (...args: unknown[]) => Promise<void> }
    }

    const mentions = [{ kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }]
    await bearcode.run.start('c1', 'hi', 'anthropic/claude-sonnet-5', '/proj', null, mentions)

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:run:start',
      'c1',
      'hi',
      'anthropic/claude-sonnet-5',
      '/proj',
      null,
      mentions,
      null
    )
  })

  it('forwards null when mentions is omitted', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      run: { start: (...args: unknown[]) => Promise<void> }
    }

    invoke.mockClear()
    await bearcode.run.start('c1', 'hi', 'anthropic/claude-sonnet-5', '/proj')

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:run:start',
      'c1',
      'hi',
      'anthropic/claude-sonnet-5',
      '/proj',
      null,
      null,
      null
    )
  })

  it('run.start forwards attachments as the 7th arg', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      run: { start: (...args: unknown[]) => Promise<void> }
    }

    invoke.mockClear()
    const attachments = [{ id: 'a1', name: 'x.png', mime: 'image/png' }]
    await bearcode.run.start('c1', 'hi', 'anthropic/claude-sonnet-5', null, null, null, attachments)

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:run:start',
      'c1',
      'hi',
      'anthropic/claude-sonnet-5',
      null,
      null,
      null,
      attachments
    )
  })
})

describe('preload updater bridge', () => {
  it('app.getVersion invokes bearcode:app:getVersion', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { app: { getVersion: () => Promise<string> } }
    invoke.mockClear()
    invoke.mockResolvedValueOnce('1.0.0')
    await expect(bearcode.app.getVersion()).resolves.toBe('1.0.0')
    expect(invoke).toHaveBeenCalledWith('bearcode:app:getVersion')
  })

  it('updater.checkNow invokes bearcode:updater:checkNow', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { updater: { checkNow: () => Promise<unknown> } }
    invoke.mockClear()
    await bearcode.updater.checkNow()
    expect(invoke).toHaveBeenCalledWith('bearcode:updater:checkNow')
  })

  it('updater.installNow invokes bearcode:updater:installNow', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { updater: { installNow: () => Promise<void> } }
    invoke.mockClear()
    await bearcode.updater.installNow()
    expect(invoke).toHaveBeenCalledWith('bearcode:updater:installNow')
  })

  it('onUpdaterStatus subscribes to bearcode:updater:status and returns an unsubscribe fn', async () => {
    const { ipcRenderer } = await import('electron')
    await import('./index')
    const bearcode = exposed as unknown as {
      onUpdaterStatus: (cb: (status: unknown) => void) => () => void
    }
    const cb = vi.fn()
    const unsubscribe = bearcode.onUpdaterStatus(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith('bearcode:updater:status', expect.any(Function))
    unsubscribe()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      'bearcode:updater:status',
      expect.any(Function)
    )
  })
})
