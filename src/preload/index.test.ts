import { describe, it, expect, vi } from 'vitest'
import type { BrowserStatus } from '../shared/types'

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

describe('preload browser status bridge', () => {
  it('subscribes to typed status pushes and removes the exact listener on cleanup', async () => {
    const { ipcRenderer } = await import('electron')
    await import('./index')
    const bearcode = exposed as unknown as {
      browser: { onStatus: (cb: (status: BrowserStatus) => void) => () => void }
    }
    const status: BrowserStatus = {
      phase: 'ready',
      message: null,
      installed: true,
      connected: true,
      conversationId: 'conversation-1',
      debuggingEnabled: true
    }
    const cb = vi.fn()

    const unsubscribe = bearcode.browser.onStatus(cb)
    const listener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)![1]
    listener({} as Electron.IpcRendererEvent, status)

    expect(ipcRenderer.on).toHaveBeenCalledWith('bearcode:browser:status', listener)
    expect(cb).toHaveBeenCalledExactlyOnceWith(status)

    unsubscribe()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('bearcode:browser:status', listener)
  })
})

describe('preload native Hermes interaction bridge', () => {
  it('forwards mode-specific health checks and credential writes without exposing stored secrets', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      hermes: {
        testConnection: (mode: string, url: string, secret?: string) => Promise<unknown>
        setLegacyToken: (token: string) => Promise<void>
        setPlatformKey: (key: string) => Promise<void>
      }
    }
    invoke.mockClear()

    await bearcode.hermes.testConnection('native', 'ws://x:8643', 'draft-platform-key')
    await bearcode.hermes.setLegacyToken('legacy-token')
    await bearcode.hermes.setPlatformKey('platform-key')

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'bearcode:hermes:test-connection',
      'native',
      'ws://x:8643',
      'draft-platform-key'
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'bearcode:hermes:set-legacy-token',
      'legacy-token'
    )
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      'bearcode:hermes:set-platform-key',
      'platform-key'
    )
    expect(Object.keys(bearcode.hermes)).not.toContain('getPlatformKey')
    expect(Object.keys(bearcode.hermes)).not.toContain('getLegacyToken')
    expect(Object.keys(bearcode.hermes)).not.toContain('installationId')
  })

  it('forwards approval resolution without exposing native credentials', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      hermes: {
        resolveApproval: (
          conversationId: string,
          requestId: string,
          decision: 'once' | 'session' | 'always' | 'deny'
        ) => Promise<void>
      }
    }
    invoke.mockClear()

    await bearcode.hermes.resolveApproval('conversation-id', 'request-id', 'once')

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:hermes:resolve-approval',
      'conversation-id',
      'request-id',
      'once'
    )
    expect(Object.keys(bearcode.hermes)).not.toContain('platformKey')
  })

  it('forwards clarification resolution without exposing downloaded file paths', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      hermes: {
        resolveClarification: (
          conversationId: string,
          requestId: string,
          response: string
        ) => Promise<void>
      }
    }
    invoke.mockClear()

    await bearcode.hermes.resolveClarification('conversation-id', 'request-id', 'desktop')

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:hermes:resolve-clarification',
      'conversation-id',
      'request-id',
      'desktop'
    )
    expect(Object.keys(bearcode.hermes)).not.toContain('downloadPath')
  })
})

describe('preload attachment preview bridge', () => {
  it('forwards opaque conversation and attachment IDs without a filesystem path', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      attachments: {
        preview: (conversationId: string, id: string) => Promise<unknown>
      }
    }
    const userDataDir = '/tmp/bearcode-user-data'
    invoke.mockClear()

    await bearcode.attachments.preview('conv_123', 'att_123')

    expect(invoke).toHaveBeenCalledWith(
      'bearcode:attachments:preview',
      'conv_123',
      'att_123'
    )
    expect(invoke).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(userDataDir)
    )
  })
})

describe('preload attachment save bridge', () => {
  it('forwards only opaque conversation and attachment IDs to native Save As', async () => {
    await import('./index')
    const bearcode = exposed as unknown as {
      attachments: {
        save: (conversationId: string, id: string) => Promise<'saved' | 'cancelled'>
      }
    }
    invoke.mockClear()

    await bearcode.attachments.save('conv_123', 'att_123')

    expect(invoke).toHaveBeenCalledWith('bearcode:attachments:save', 'conv_123', 'att_123')
  })
})
