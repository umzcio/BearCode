import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('@langchain/langgraph', () => ({ interrupt: vi.fn() }))
// buildSandboxPolicy (real, unmocked) calls electron's app.getPath; outside
// the Electron main process the 'electron' package resolves to a path
// string, so this needs the same stub the other main-process tests use.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-userdata' } }))
vi.mock('../permissions', async (orig) => ({
  ...(await orig<typeof import('../permissions')>()),
  evaluateCommandForConversation: vi.fn(() => 'run'),
  evaluateUnsandboxedForConversation: vi.fn(() => 'block'), // default: run wrapped
  resolveConversationMode: vi.fn(() => 'auto')
}))
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getConversationMeta: vi.fn(() => ({ projectPath: '/tmp' })),
  getProjectSettings: vi.fn(() => ({ sandboxMode: true, sandboxAllowNetwork: false }))
}))
vi.mock('./sandbox/runner', () => ({
  seatbeltRunner: {
    available: vi.fn(() => true),
    wrap: vi.fn((command: string) => ({
      file: 'sandbox-exec',
      args: ['-p', '(deny default)', '/bin/zsh', '-lc', command],
      env: { PATH: '/x' }
    }))
  }
}))

import { spawn } from 'child_process'
import { interrupt } from '@langchain/langgraph'
import { buildTools } from './tools'
import { evaluateUnsandboxedForConversation } from '../permissions'
import { seatbeltRunner } from './sandbox/runner'

const spawnMock = vi.mocked(spawn)
const interruptMock = vi.mocked(interrupt)

// Make spawn resolve immediately (close code 0, empty streams).
function wireSpawn(): void {
  spawnMock.mockImplementation(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const child = {
      pid: 1234,
      stdout: { on: (_e: string, _cb: (d: Buffer) => void) => {} },
      stderr: { on: (_e: string, _cb: (d: Buffer) => void) => {} },
      on: (e: string, cb: (arg?: unknown) => void) => {
        handlers[e] = cb
        if (e === 'close') setTimeout(() => cb(0), 0)
      },
      kill: () => {}
    }
    return child as unknown as ReturnType<typeof spawn>
  })
}

// Test-only widening (mirrors tools.test.ts's InvokableTool): the tool's
// zod-inferred invoke signature isn't worth reproducing here.
interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}

function runTool(): InvokableTool {
  const tools = buildTools(
    '/tmp',
    'conv1',
    { emit: () => {} } as never,
    'grp'
  ) as unknown as InvokableTool[]
  return tools.find((t) => t.name === 'run_command')!
}

describe('runCommandTool sandbox branching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wireSpawn()
  })

  it('sandbox on + unsandboxed=block => spawns WRAPPED (sandbox-exec) with scrubbed env', async () => {
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc1' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe('sandbox-exec')
    expect((spawnMock.mock.calls[0][2] as { env?: unknown }).env).toEqual({ PATH: '/x' })
  })

  it('sandbox on + unsandboxed=allow => spawns RAW (/bin/zsh, inherit env)', async () => {
    vi.mocked(evaluateUnsandboxedForConversation).mockReturnValue('run')
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc2' })
    expect(spawnMock.mock.calls[0][0]).toBe('/bin/zsh')
    expect((spawnMock.mock.calls[0][2] as { env?: unknown }).env).toBeUndefined()
  })

  it('sandbox on + unsandboxed=prompt => interrupts (run_command_unsandboxed), spawns raw on approval', async () => {
    vi.mocked(evaluateUnsandboxedForConversation).mockReturnValue('prompt')
    interruptMock.mockReturnValue({ approved: true })
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc3' })
    expect(interruptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'run_command_unsandboxed',
        command: 'echo hi',
        toolCallId: 'tc3'
      })
    )
    expect(spawnMock.mock.calls[0][0]).toBe('/bin/zsh')
  })

  it('unsandboxed prompt denied => spawns WRAPPED', async () => {
    vi.mocked(evaluateUnsandboxedForConversation).mockReturnValue('prompt')
    interruptMock.mockReturnValue({ approved: false })
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc4' })
    expect(spawnMock.mock.calls[0][0]).toBe('sandbox-exec')
  })

  it('runner unavailable => spawns RAW even with sandbox on', async () => {
    vi.mocked(seatbeltRunner.available).mockReturnValue(false)
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc5' })
    expect(spawnMock.mock.calls[0][0]).toBe('/bin/zsh')
  })

  it('sandbox OFF => spawns RAW, never consults unsandboxed', async () => {
    const { getProjectSettings } = await import('../db')
    vi.mocked(getProjectSettings).mockReturnValue({
      path: '/tmp',
      name: null,
      color: null,
      icon: null,
      defaultModelRef: null,
      defaultEffort: null,
      defaultPermissionMode: null,
      sandboxMode: false,
      sandboxAllowNetwork: false
    })
    const tool = runTool()
    await tool.invoke({ command: 'echo hi' }, { toolCallId: 'tc6' })
    expect(evaluateUnsandboxedForConversation).not.toHaveBeenCalled()
    expect(spawnMock.mock.calls[0][0]).toBe('/bin/zsh')
  })
})
