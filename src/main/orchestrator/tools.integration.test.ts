import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors tools.mcp.test.ts's mocking discipline: mock every electron/db-
// touching module so importing tools.ts never opens a real database, plus the
// integrations surface (store connection state + the authenticated API helper)
// that buildIntegrationTools consumes. No real network, no real vault.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run'),
  evaluateEditForConversation: vi.fn(() => 'run'),
  evaluateMcpForConversation: vi.fn(() => 'run'),
  evaluateIntegrationForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../db', () => ({
  appendOrReplaceEvent: vi.fn(),
  getConversationMeta: vi.fn(() => ({ projectPath: '/proj' })),
  isProjectTrusted: vi.fn(() => true)
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
    mcpEnabled: false,
    mcpEnabledServers: []
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
  loadServers: vi.fn(() => []),
  isEnabled: vi.fn(() => false),
  isTrusted: vi.fn(() => false)
}))
vi.mock('../mcp/manager', () => ({
  mcpManager: {
    listTools: vi.fn(() => []),
    toolSchema: vi.fn(() => undefined),
    callTool: vi.fn(async () => '')
  }
}))
vi.mock('../integrations/store', () => ({
  getIntegration: vi.fn((provider: string) => ({
    provider,
    connected: provider === 'github'
  }))
}))
vi.mock('../integrations/github', () => ({
  githubApi: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
}))
vi.mock('../integrations/bitbucket', () => ({
  bitbucketApi: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
}))
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn()
}))

import { evaluateIntegrationForConversation } from '../permissions'
import { getIntegration } from '../integrations/store'
import { githubApi } from '../integrations/github'
import { bitbucketApi } from '../integrations/bitbucket'
import { interrupt } from '@langchain/langgraph'
import {
  buildIntegrationTools,
  clearDeniedReplayPins,
  pinDeniedReplays,
  takeDeniedIntegrationReplayPin
} from './tools'

interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const integrationTools = (): Record<string, InvokableTool> => {
  const tools = buildIntegrationTools('convo') as unknown as InvokableTool[]
  return Object.fromEntries(tools.map((t) => [t.name, t]))
}

beforeEach(() => {
  clearDeniedReplayPins('convo')
  vi.mocked(getIntegration).mockImplementation(
    (provider: string) => ({ provider, connected: provider === 'github' }) as never
  )
  vi.mocked(evaluateIntegrationForConversation).mockReturnValue('run')
  vi.mocked(githubApi)
    .mockReset()
    .mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response)
  vi.mocked(bitbucketApi)
    .mockReset()
    .mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response)
  vi.mocked(interrupt).mockReset()
})

describe('buildIntegrationTools presence gate', () => {
  it('returns [] when neither GitHub nor Bitbucket is connected', () => {
    vi.mocked(getIntegration).mockReturnValue({ provider: 'github', connected: false })
    expect(buildIntegrationTools('convo')).toEqual([])
  })

  it('exposes the four github_* tools when connected', () => {
    const names = Object.keys(integrationTools()).sort()
    expect(names).toEqual(
      ['github_create_pr', 'github_get_issue', 'github_list_prs', 'github_list_repos'].sort()
    )
  })
})

describe('github_* gate + call', () => {
  it('calls githubApi and returns output on allow (list_repos)', async () => {
    vi.mocked(githubApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ full_name: 'me/repo', private: true, description: 'd', html_url: 'u' }]
    } as unknown as Response)
    const out = await integrationTools()['github_list_repos'].invoke({})
    expect(githubApi).toHaveBeenCalled()
    expect(out).toContain('me/repo')
  })

  it('returns a blocked message and never calls the API on block', async () => {
    vi.mocked(evaluateIntegrationForConversation).mockReturnValue('block')
    const out = await integrationTools()['github_create_pr'].invoke({
      owner: 'o',
      repo: 'r',
      title: 't',
      head: 'h',
      base: 'b'
    })
    expect(out).toMatch(/Blocked/)
    expect(githubApi).not.toHaveBeenCalled()
  })

  it('prompts via interrupt() on "prompt" and returns denial when not approved', async () => {
    vi.mocked(evaluateIntegrationForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const out = await integrationTools()['github_create_pr'].invoke({
      owner: 'o',
      repo: 'r',
      title: 't',
      head: 'h',
      base: 'b'
    })
    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'integration', tool: 'github_create_pr' })
    )
    expect(out).toBe('User denied this integration tool call.')
    expect(githubApi).not.toHaveBeenCalled()
  })

  it('proceeds to call the API when the interrupt approval is granted', async () => {
    vi.mocked(evaluateIntegrationForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    vi.mocked(githubApi).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 7, html_url: 'pr-url' })
    } as unknown as Response)
    const out = await integrationTools()['github_create_pr'].invoke({
      owner: 'o',
      repo: 'r',
      title: 't',
      head: 'h',
      base: 'b'
    })
    expect(githubApi).toHaveBeenCalledWith(
      '/repos/o/r/pulls',
      expect.objectContaining({ method: 'POST' })
    )
    expect(out).toContain('pr-url')
  })
})

describe('read-only tagging (plan-mode divergence)', () => {
  it('tags list/get tools read-only and create_pr as a mutation', async () => {
    await integrationTools()['github_list_repos'].invoke({})
    await integrationTools()['github_get_issue'].invoke({ owner: 'o', repo: 'r', number: 1 })
    await integrationTools()['github_list_prs'].invoke({ owner: 'o', repo: 'r' })
    await integrationTools()['github_create_pr'].invoke({
      owner: 'o',
      repo: 'r',
      title: 't',
      head: 'h',
      base: 'b'
    })
    const calls = vi.mocked(evaluateIntegrationForConversation).mock.calls
    const readOnlyOf = (tool: string): boolean | undefined => calls.find((c) => c[1] === tool)?.[2]
    expect(readOnlyOf('list_repos')).toBe(true)
    expect(readOnlyOf('get_issue')).toBe(true)
    expect(readOnlyOf('list_prs')).toBe(true)
    expect(readOnlyOf('create_pr')).toBe(false)
  })
})

describe('per-call recheck (connection lost mid-run)', () => {
  it('blocks and never calls the API when GitHub disconnects after build', async () => {
    const t = integrationTools()['github_list_repos']
    vi.mocked(getIntegration).mockReturnValue({ provider: 'github', connected: false })
    const out = await t.invoke({})
    expect(out).toMatch(/no longer connected/i)
    expect(githubApi).not.toHaveBeenCalled()
  })
})

describe('bitbucket_* presence gate + gate + call', () => {
  const withBitbucketConnected = (): void => {
    vi.mocked(getIntegration).mockImplementation(
      (provider: string) => ({ provider, connected: provider === 'bitbucket' }) as never
    )
  }

  it('is absent when Bitbucket is not connected (default mock: only GitHub connected)', () => {
    const names = Object.keys(integrationTools())
    expect(names).not.toContain('bitbucket_list_repos')
    expect(names).not.toContain('bitbucket_create_pr')
  })

  it('exposes the two bitbucket_* tools when connected', () => {
    withBitbucketConnected()
    const names = Object.keys(integrationTools()).sort()
    expect(names).toEqual(['bitbucket_create_pr', 'bitbucket_list_repos'].sort())
  })

  it('calls bitbucketApi and returns output on allow (list_repos)', async () => {
    withBitbucketConnected()
    vi.mocked(bitbucketApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        values: [{ full_name: 'team/repo', is_private: true, description: 'd' }]
      })
    } as unknown as Response)
    const out = await integrationTools()['bitbucket_list_repos'].invoke({ workspace: 'team' })
    expect(bitbucketApi).toHaveBeenCalledWith('/repositories/team?role=member')
    expect(out).toContain('team/repo')
  })

  it('tags list_repos read-only and create_pr as a mutation', async () => {
    withBitbucketConnected()
    vi.mocked(bitbucketApi).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ values: [] })
    } as unknown as Response)
    await integrationTools()['bitbucket_list_repos'].invoke({ workspace: 'team' })
    await integrationTools()['bitbucket_create_pr'].invoke({
      workspace: 'team',
      repoSlug: 'repo',
      title: 't',
      sourceBranch: 'feature'
    })
    const calls = vi.mocked(evaluateIntegrationForConversation).mock.calls
    const readOnlyOf = (tool: string): boolean | undefined => calls.find((c) => c[1] === tool)?.[2]
    expect(readOnlyOf('list_repos')).toBe(true)
    expect(readOnlyOf('create_pr')).toBe(false)
  })

  it('sends the source/destination branch payload and returns the PR URL on create_pr', async () => {
    withBitbucketConnected()
    vi.mocked(bitbucketApi).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 9, links: { html: { href: 'pr-url' } } })
    } as unknown as Response)
    const out = await integrationTools()['bitbucket_create_pr'].invoke({
      workspace: 'team',
      repoSlug: 'repo',
      title: 't',
      sourceBranch: 'feature',
      destinationBranch: 'main'
    })
    expect(bitbucketApi).toHaveBeenCalledWith(
      '/repositories/team/repo/pullrequests',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 't',
          source: { branch: { name: 'feature' } },
          destination: { branch: { name: 'main' } }
        })
      })
    )
    expect(out).toContain('pr-url')
  })

  it('returns a blocked message and never calls the API on block', async () => {
    withBitbucketConnected()
    vi.mocked(evaluateIntegrationForConversation).mockReturnValue('block')
    const out = await integrationTools()['bitbucket_create_pr'].invoke({
      workspace: 'team',
      repoSlug: 'repo',
      title: 't',
      sourceBranch: 'feature'
    })
    expect(out).toMatch(/Blocked/)
    expect(bitbucketApi).not.toHaveBeenCalled()
  })

  it('blocks and never calls the API when Bitbucket disconnects after build', async () => {
    withBitbucketConnected()
    const t = integrationTools()['bitbucket_list_repos']
    vi.mocked(getIntegration).mockReturnValue({ provider: 'bitbucket', connected: false })
    const out = await t.invoke({ workspace: 'team' })
    expect(out).toMatch(/no longer connected/i)
    expect(bitbucketApi).not.toHaveBeenCalled()
  })
})

describe('takeDeniedIntegrationReplayPin', () => {
  it('consumes a byIntegrationAction pin without touching other namespaces', () => {
    pinDeniedReplays('convo', [{ integrationAction: 'github.list_repos' }])
    expect(takeDeniedIntegrationReplayPin('convo', undefined, 'github.list_repos')).toBe(true)
    // take-once: a second take on the same action fails.
    expect(takeDeniedIntegrationReplayPin('convo', undefined, 'github.list_repos')).toBe(false)
  })

  it('a denied-pin replay wins over the gate even when the decision has flipped to allow', async () => {
    pinDeniedReplays('convo', [{ integrationAction: 'github.list_repos' }])
    vi.mocked(evaluateIntegrationForConversation).mockReturnValue('run')
    const out = await integrationTools()['github_list_repos'].invoke({})
    expect(out).toBe('User denied this integration tool call.')
    expect(githubApi).not.toHaveBeenCalled()
  })
})
