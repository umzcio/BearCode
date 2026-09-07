import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same mocking idiom as ipc.mcp.test.ts (registerIpc() pulls in nearly the
// whole main-process graph) -- kept in its own file so the compat mocks don't
// have to be threaded through the existing suites.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-compat-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./keys', () => ({
  keyStatus: vi.fn(),
  setKey: vi.fn(),
  setVaultSecret: vi.fn(),
  setCompatKey: vi.fn(),
  compatKeyStatus: vi.fn(() => ({})),
  getCompatKey: vi.fn()
}))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
const COMPAT_ENDPOINTS = [
  { id: 'vllm', name: 'vLLM box', baseUrl: 'http://gpu.local:8000' },
  { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234' }
]
vi.mock('./settings', () => ({
  getSettings: vi.fn(() => ({ compatEndpoints: COMPAT_ENDPOINTS })),
  setSettings: vi.fn(),
  settingsInfo: vi.fn(),
  // Real implementation of the guard (mirrors settings.ts): the probe handler
  // validates renderer-supplied URLs through it.
  isHttpUrl: (raw: unknown): boolean => {
    if (typeof raw !== 'string' || raw.length === 0) return false
    try {
      const u = new URL(raw)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }
}))
vi.mock('./providers/registry', () => ({
  listAllModels: vi.fn(),
  listManageableModels: vi.fn(() => []),
  listOllamaModels: vi.fn(),
  listCompatModels: vi.fn()
}))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('./db', () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  clearAll: vi.fn(),
  insertArtifactComment: vi.fn(),
  listArtifactComments: vi.fn(() => []),
  isProjectTrusted: vi.fn(() => true)
}))
vi.mock('./agentsDir', () => ({ loadAgentsContent: vi.fn() }))
vi.mock('./orchestrator/commands', () => ({ listCommands: vi.fn() }))
vi.mock('./orchestrator/mentionSuggest', () => ({
  suggestFiles: vi.fn(),
  manualRuleInfos: vi.fn()
}))
vi.mock('./orchestrator', () => ({
  assertValidAttachments: vi.fn(),
  assertValidCommand: vi.fn(),
  assertValidMentions: vi.fn(),
  assertValidPlanReviewResolution: vi.fn(),
  cancelRunOrchestrator: vi.fn(),
  clearRunsOrchestrator: vi.fn(),
  forgetRunOrchestrator: vi.fn(),
  pruneCheckpoints: vi.fn(),
  resolveApprovalOrchestrator: vi.fn(),
  resolvePlanReviewOrchestrator: vi.fn(),
  resumeInterruptedRuns: vi.fn(),
  startRunOrchestrator: vi.fn()
}))
vi.mock('./mcp/store', () => ({
  loadServers: vi.fn(() => []),
  upsertServer: vi.fn(),
  removeServer: vi.fn(),
  isEnabled: vi.fn(() => true),
  setEnabled: vi.fn(),
  isTrusted: vi.fn(() => true),
  trustProjectServer: vi.fn(),
  hasSpawnConsent: vi.fn(() => false),
  grantSpawnConsent: vi.fn()
}))
vi.mock('./mcp/manager', () => ({
  mcpManager: {
    statusOf: vi.fn(() => ({ state: 'disabled' })),
    enable: vi.fn(async () => ({ state: 'connected', tools: [] })),
    reconnect: vi.fn(async () => ({ state: 'connected', tools: [] })),
    teardown: vi.fn(async () => undefined)
  }
}))

import { registerIpc } from './ipc'

describe('bearcode:compat:* IPC surface', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc()
  })

  it('registers the compat channel set', () => {
    for (const channel of ['bearcode:compat:set-key', 'bearcode:compat:key-status']) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('set-key writes through keys.setCompatKey with the configured endpoint ids', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    handler(null, 'vllm', 'sekret')
    expect(setCompatKey).toHaveBeenCalledWith('vllm', 'sekret', ['vllm', 'lm-studio'])
  })

  it('set-key passes an empty value through unchanged (clearing is keys.ts convention)', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    handler(null, 'vllm', '')
    expect(setCompatKey).toHaveBeenCalledWith('vllm', '', ['vllm', 'lm-studio'])
  })

  it('set-key rejects a non-string endpoint id before touching keys', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    expect(() => handler(null, 42, 'sekret')).toThrow(/endpoint id/i)
    expect(() => handler(null, '', 'sekret')).toThrow(/endpoint id/i)
    expect(setCompatKey).not.toHaveBeenCalled()
  })

  it('set-key rejects a non-string value', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    expect(() => handler(null, 'vllm', null)).toThrow(/secret value/i)
    expect(setCompatKey).not.toHaveBeenCalled()
  })

  it('key-status derives from the configured endpoints and returns booleans only', async () => {
    const handler = handlers.get('bearcode:compat:key-status')!
    const { compatKeyStatus } = await import('./keys')
    vi.mocked(compatKeyStatus).mockReturnValue({ vllm: true, 'lm-studio': false })
    const result = handler(null)
    expect(compatKeyStatus).toHaveBeenCalledWith(['vllm', 'lm-studio'])
    expect(result).toEqual({ vllm: true, 'lm-studio': false })
  })
})

describe('bearcode:endpoints:probe IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc()
  })

  it('registers the probe channel', () => {
    expect(handlers.get('bearcode:endpoints:probe')).toBeTypeOf('function')
  })

  it('probes an Ollama server and returns reachable + modelCount', async () => {
    const handler = handlers.get('bearcode:endpoints:probe')!
    const { listOllamaModels } = await import('./providers/registry')
    vi.mocked(listOllamaModels).mockResolvedValue({
      models: [
        { id: 'llama3', label: 'llama3' },
        { id: 'qwen3:8b', label: 'qwen3:8b' }
      ],
      reachable: true
    })
    const result = await handler(null, { provider: 'ollama', baseUrl: 'http://localhost:11434' })
    expect(listOllamaModels).toHaveBeenCalledWith({ baseUrl: 'http://localhost:11434' })
    expect(result).toEqual({ reachable: true, modelCount: 2, note: undefined })
  })

  it('probes a compat server, attaching the vault key only when endpointId is given', async () => {
    const handler = handlers.get('bearcode:endpoints:probe')!
    const { listCompatModels } = await import('./providers/registry')
    const { getCompatKey } = await import('./keys')
    vi.mocked(getCompatKey).mockReturnValue('sekret')
    vi.mocked(listCompatModels).mockResolvedValue({
      models: [{ id: 'qwen3-32b', label: 'qwen3-32b' }],
      reachable: true
    })

    const saved = await handler(null, {
      provider: 'compat',
      baseUrl: 'http://gpu.local:8000',
      endpointId: 'vllm'
    })
    expect(getCompatKey).toHaveBeenCalledWith('vllm')
    expect(listCompatModels).toHaveBeenCalledWith({
      baseUrl: 'http://gpu.local:8000',
      apiKey: 'sekret'
    })
    expect(saved).toEqual({ reachable: true, modelCount: 1, note: undefined })

    // Draft-row probe (no endpointId): unauthenticated, vault never read.
    vi.mocked(getCompatKey).mockClear()
    await handler(null, { provider: 'compat', baseUrl: 'http://gpu.local:8000' })
    expect(getCompatKey).not.toHaveBeenCalled()
    expect(listCompatModels).toHaveBeenLastCalledWith({
      baseUrl: 'http://gpu.local:8000',
      apiKey: undefined
    })
  })

  it('passes the unreachable note through with modelCount 0', async () => {
    const handler = handlers.get('bearcode:endpoints:probe')!
    const { listCompatModels } = await import('./providers/registry')
    vi.mocked(listCompatModels).mockResolvedValue({
      models: [],
      reachable: false,
      note: 'Endpoint unreachable'
    })
    const result = await handler(null, { provider: 'compat', baseUrl: 'http://gpu.local:8000' })
    expect(result).toEqual({ reachable: false, modelCount: 0, note: 'Endpoint unreachable' })
  })

  it('rejects bad input as an unreachable result, never throwing or probing', async () => {
    const handler = handlers.get('bearcode:endpoints:probe')!
    const { listOllamaModels, listCompatModels } = await import('./providers/registry')
    for (const args of [
      { provider: 'anthropic', baseUrl: 'http://localhost:11434' },
      { provider: 'ollama', baseUrl: 'not-a-url' },
      { provider: 'ollama', baseUrl: 'ftp://localhost:11434' },
      { provider: 'ollama' },
      null,
      42
    ]) {
      const result = (await handler(null, args)) as { reachable: boolean; note?: string }
      expect(result.reachable).toBe(false)
      expect(typeof result.note).toBe('string')
    }
    expect(listOllamaModels).not.toHaveBeenCalled()
    expect(listCompatModels).not.toHaveBeenCalled()
  })

  it('never rejects to the renderer even when the probe throws unexpectedly', async () => {
    const handler = handlers.get('bearcode:endpoints:probe')!
    const { listOllamaModels } = await import('./providers/registry')
    vi.mocked(listOllamaModels).mockRejectedValue(new Error('boom'))
    const result = await handler(null, { provider: 'ollama', baseUrl: 'http://localhost:11434' })
    expect(result).toEqual({ reachable: false, note: 'Probe failed' })
  })
})
