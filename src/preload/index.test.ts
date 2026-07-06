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
