import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors tools.browser.test.ts's mocking discipline: mock every
// electron/db-touching module so importing tools.ts never opens a real
// database, and mock the MCP surface (store + manager) tools.ts consumes.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run'),
  evaluateEditForConversation: vi.fn(() => 'run'),
  evaluateMcpForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../db', () => ({
  appendOrReplaceEvent: vi.fn(),
  getConversationMeta: vi.fn(() => ({ projectPath: '/proj' }))
}))
vi.mock('../artifacts/store', () => ({
  createPlanArtifact: vi.fn(),
  createWalkthroughArtifact: vi.fn(),
  approvePlanArtifact: vi.fn()
}))
vi.mock('../agentsDir', () => ({ loadAgentsContent: vi.fn(() => ({ rules: [], workflows: [] })) }))
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({
    browserEnabled: false,
    browserAllowlist: [],
    browserBlocklist: [],
    mcpEnabled: true,
    mcpEnabledServers: ['srv']
  }))
}))
vi.mock('../browser/manager', () => ({
  browserManager: {
    setPolicyProvider: vi.fn(),
    start: vi.fn(async () => {}),
    navigate: vi.fn(async () => ({ url: '', title: '' })),
    read: vi.fn(async () => ''),
    screenshot: vi.fn(async () => ''),
    stashScreenshot: vi.fn(),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    evaluate: vi.fn(async () => '')
  }
}))
vi.mock('../mcp/store', () => ({
  loadServers: vi.fn(() => [{ name: 'srv', transport: 'http', source: 'global' }]),
  isEnabled: vi.fn(() => true),
  isTrusted: vi.fn(() => true)
}))
vi.mock('../mcp/manager', () => ({
  mcpManager: {
    listTools: vi.fn(() => [{ name: 'get_x', description: 'd', readOnlyHint: false }]),
    callTool: vi.fn(async () => 'x-out')
  }
}))
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn()
}))

import { evaluateMcpForConversation } from '../permissions'
import { getSettings } from '../settings'
import { isEnabled, isTrusted } from '../mcp/store'
import { mcpManager } from '../mcp/manager'
import { interrupt } from '@langchain/langgraph'
import {
  buildMcpTools,
  clearDeniedReplayPins,
  pinDeniedReplays,
  takeDeniedMcpReplayPin
} from './tools'

interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const mcpTools = (): Record<string, InvokableTool> => {
  const tools = buildMcpTools('convo') as unknown as InvokableTool[]
  return Object.fromEntries(tools.map((t) => [t.name, t]))
}

beforeEach(() => {
  clearDeniedReplayPins('convo')
  vi.mocked(getSettings).mockReturnValue({
    browserEnabled: false,
    browserAllowlist: [],
    browserBlocklist: [],
    mcpEnabled: true,
    mcpEnabledServers: ['srv']
  } as unknown as ReturnType<typeof getSettings>)
  vi.mocked(isEnabled).mockReturnValue(true)
  vi.mocked(isTrusted).mockReturnValue(true)
  vi.mocked(evaluateMcpForConversation).mockReturnValue('run')
  vi.mocked(mcpManager.listTools).mockReturnValue([
    { name: 'get_x', description: 'd', readOnlyHint: false }
  ])
  vi.mocked(mcpManager.callTool).mockClear().mockResolvedValue('x-out')
  vi.mocked(interrupt).mockReset()
})

describe('buildMcpTools master gate', () => {
  it('returns [] when mcpEnabled is false', () => {
    vi.mocked(getSettings).mockReturnValue({
      browserEnabled: false,
      browserAllowlist: [],
      browserBlocklist: [],
      mcpEnabled: false,
      mcpEnabledServers: ['srv']
    } as unknown as ReturnType<typeof getSettings>)
    expect(buildMcpTools('convo')).toEqual([])
  })

  it('returns [] when no server is both enabled and trusted', () => {
    vi.mocked(isTrusted).mockReturnValue(false)
    expect(buildMcpTools('convo')).toEqual([])
  })

  it('returns one tool() per cached tool of each enabled+trusted server', () => {
    const names = Object.keys(mcpTools())
    expect(names).toEqual(['mcp__srv__get_x'])
  })
})

describe('mcp__<server>__<tool> gate + call', () => {
  it('calls mcpManager.callTool and returns its output on allow', async () => {
    const out = await mcpTools()['mcp__srv__get_x'].invoke({ q: 1 })
    expect(mcpManager.callTool).toHaveBeenCalledWith('srv', 'get_x', { q: 1 })
    expect(out).toBe('x-out')
  })

  it('returns a blocked message and never calls the server on block', async () => {
    vi.mocked(evaluateMcpForConversation).mockReturnValue('block')
    const out = await mcpTools()['mcp__srv__get_x'].invoke({})
    expect(out).toMatch(/Blocked/)
    expect(mcpManager.callTool).not.toHaveBeenCalled()
  })

  it('prompts via interrupt() on "prompt" and returns denial when not approved', async () => {
    vi.mocked(evaluateMcpForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const out = await mcpTools()['mcp__srv__get_x'].invoke({})
    expect(interrupt).toHaveBeenCalled()
    expect(out).toBe('User denied this MCP tool call.')
    expect(mcpManager.callTool).not.toHaveBeenCalled()
  })

  it('proceeds to call the server when the interrupt approval is granted', async () => {
    vi.mocked(evaluateMcpForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    const out = await mcpTools()['mcp__srv__get_x'].invoke({})
    expect(mcpManager.callTool).toHaveBeenCalledWith('srv', 'get_x', {})
    expect(out).toBe('x-out')
  })
})

describe('takeDeniedMcpReplayPin', () => {
  it('consumes a byMcpAction pin without touching command/browser/edit namespaces', () => {
    pinDeniedReplays('convo', [{ mcpAction: 'srv.get_x' }])
    expect(takeDeniedMcpReplayPin('convo', undefined, 'srv.get_x')).toBe(true)
    // take-once: a second take on the same action fails.
    expect(takeDeniedMcpReplayPin('convo', undefined, 'srv.get_x')).toBe(false)
  })

  it('a denied-pin replay wins over the gate even when the decision has flipped to allow', async () => {
    pinDeniedReplays('convo', [{ mcpAction: 'srv.get_x' }])
    vi.mocked(evaluateMcpForConversation).mockReturnValue('run')
    const out = await mcpTools()['mcp__srv__get_x'].invoke({})
    expect(out).toBe('User denied this MCP tool call.')
    expect(mcpManager.callTool).not.toHaveBeenCalled()
  })
})
