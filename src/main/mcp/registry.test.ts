import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../keys', () => ({
  getVaultSecret: vi.fn()
}))

import { getVaultSecret } from '../keys'
import { smitherySearch, fetchSmitheryConfig, SmitheryKeyMissingError } from './registry'

const mockedGetVaultSecret = vi.mocked(getVaultSecret)

describe('smitherySearch', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  it('throws a typed error when no Smithery key is configured', async () => {
    mockedGetVaultSecret.mockReturnValue(undefined)
    await expect(smitherySearch('exa')).rejects.toBeInstanceOf(SmitheryKeyMissingError)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('maps a canned registry payload to SmitheryHit[]', async () => {
    mockedGetVaultSecret.mockReturnValue('sk-test-key')
    const payload = {
      servers: [
        {
          qualifiedName: 'exa-labs/exa-mcp',
          displayName: 'Exa Search',
          description: 'Web search for AI',
          remote: true
        },
        {
          qualifiedName: 'some/local-tool',
          displayName: '',
          description: 'A stdio tool',
          remote: false
        }
      ],
      pagination: { currentPage: 1, pageSize: 25, totalPages: 1, totalCount: 2 }
    }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as unknown as typeof fetch

    const hits = await smitherySearch('exa')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.smithery.ai/servers?q=exa'),
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test-key' } })
    )
    expect(hits).toEqual([
      {
        id: 'exa-labs/exa-mcp',
        name: 'Exa Search',
        description: 'Web search for AI',
        transport: 'http'
      },
      {
        id: 'some/local-tool',
        name: 'some/local-tool',
        description: 'A stdio tool',
        transport: 'stdio'
      }
    ])
  })

  it('throws on a non-ok response', async () => {
    mockedGetVaultSecret.mockReturnValue('sk-test-key')
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    await expect(smitherySearch('exa')).rejects.toThrow('Smithery search failed: 500')
  })
})

describe('fetchSmitheryConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  it('throws a typed error when no Smithery key is configured', async () => {
    mockedGetVaultSecret.mockReturnValue(undefined)
    await expect(fetchSmitheryConfig('exa-labs/exa-mcp')).rejects.toBeInstanceOf(
      SmitheryKeyMissingError
    )
  })

  it('maps an http connection detail to McpServerConfig with VAULT placeholders', async () => {
    mockedGetVaultSecret.mockReturnValue('sk-test-key')
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        qualifiedName: 'exa-labs/exa-mcp',
        displayName: 'Exa Search',
        deploymentUrl: 'https://mcp.exa.ai',
        connections: [
          {
            type: 'http',
            deploymentUrl: 'https://mcp.exa.ai',
            configSchema: { required: ['exaApiKey'], properties: { exaApiKey: {} } }
          }
        ]
      })
    }) as unknown as typeof fetch

    const cfg = await fetchSmitheryConfig('exa-labs/exa-mcp')

    expect(cfg).toEqual({
      name: 'exa-labs/exa-mcp',
      transport: 'http',
      url: 'https://mcp.exa.ai',
      headers: { exaApiKey: '${VAULT:mcp:exa-labs/exa-mcp:exaApiKey}' },
      source: 'global'
    })
  })

  it('maps a stdio connection detail to McpServerConfig with env VAULT placeholders', async () => {
    mockedGetVaultSecret.mockReturnValue('sk-test-key')
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        qualifiedName: 'some/local-tool',
        connections: [
          {
            type: 'stdio',
            bundleUrl: 'https://example.com/bundle.tgz',
            runtime: 'node',
            configSchema: { required: ['apiToken'], properties: { apiToken: {} } }
          }
        ]
      })
    }) as unknown as typeof fetch

    const cfg = await fetchSmitheryConfig('some/local-tool')

    expect(cfg).toEqual({
      name: 'some/local-tool',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some/local-tool'],
      env: { apiToken: '${VAULT:mcp:some/local-tool:apiToken}' },
      source: 'global'
    })
  })
})
