import { describe, it, expect } from 'vitest'
import type { ManageableProvider, ProviderModels } from '@shared/types'
import { buildModelRows, formatTokens, modelStatus, CAPABILITY_LABEL } from './modelRows'

const providers: ProviderModels[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    color: '#d97757',
    requiresKey: true,
    keyConfigured: true,
    reachable: true,
    models: []
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    keyConfigured: false,
    reachable: true,
    models: []
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    keyConfigured: true,
    reachable: false,
    models: []
  }
]

describe('modelStatus', () => {
  it('is available when the key is configured and the provider is reachable', () => {
    expect(modelStatus('anthropic', providers)).toBe('available')
  })
  it('is not-configured when the key is missing', () => {
    expect(modelStatus('openai', providers)).toBe('not-configured')
  })
  it('is unavailable when the provider is unreachable (e.g. Ollama down)', () => {
    expect(modelStatus('ollama', providers)).toBe('unavailable')
  })
  it('is unavailable for a provider id with no matching entry', () => {
    expect(modelStatus('xai', providers)).toBe('unavailable')
  })
})

describe('formatTokens', () => {
  it('formats millions', () => expect(formatTokens(1_000_000)).toBe('1M'))
  it('formats a non-round million with one decimal', () =>
    expect(formatTokens(1_050_000)).toBe('1.1M'))
  it('formats thousands', () => expect(formatTokens(200_000)).toBe('200K'))
  it('returns an em dash for missing input', () => expect(formatTokens(undefined)).toBe('—'))
})

describe('buildModelRows', () => {
  const manageableModels: ManageableProvider[] = [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      models: [
        {
          id: 'claude-sonnet-5',
          label: 'Claude Sonnet 5',
          contextWindow: 1_000_000,
          custom: false,
          enabled: true,
          liveOnly: false
        }
      ]
    }
  ]

  it('joins a manageable model with its provider status, price, metadata, catalog info, and favorite flag', () => {
    const rows = buildModelRows(manageableModels, providers, {
      modelPricing: { 'anthropic/claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 } },
      modelMetadata: {
        'anthropic/claude-sonnet-5': {
          mode: 'chat',
          maxOutputTokens: 8000,
          capabilities: {
            functionCalling: true,
            vision: false,
            responseSchema: false,
            reasoning: false,
            webSearch: false,
            codeExecution: false,
            pdfInput: false
          }
        }
      },
      favoriteModels: ['anthropic/claude-sonnet-5']
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.ref).toBe('anthropic/claude-sonnet-5')
    expect(row.status).toBe('available')
    expect(row.price).toEqual({ inputPer1M: 3, outputPer1M: 15 })
    expect(row.priceSource).toBe('synced')
    expect(row.metadata?.capabilities.functionCalling).toBe(true)
    expect(row.catalog?.description.length).toBeGreaterThan(0)
    expect(row.favorite).toBe(true)
  })

  it('leaves metadata/catalog null and favorite false for an unknown/uncatalogued model', () => {
    const rows = buildModelRows(
      [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          models: [{ id: 'my-custom', label: 'My Custom', custom: true, enabled: true, liveOnly: false }]
        }
      ],
      providers,
      {}
    )
    expect(rows[0].metadata).toBeNull()
    expect(rows[0].catalog).toBeNull()
    expect(rows[0].favorite).toBe(false)
    expect(rows[0].priceSource).toBeNull()
  })

  it('overlays live-discovered capabilities on top of LiteLLM metadata, per field', () => {
    const rows = buildModelRows(
      [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-opus-4-8',
              label: 'Claude Opus 4.8',
              custom: false,
              enabled: true,
              liveOnly: false,
              liveCapabilities: { vision: true, codeExecution: true }
            }
          ]
        }
      ],
      providers,
      {
        modelMetadata: {
          'anthropic/claude-opus-4-8': {
            mode: 'chat',
            capabilities: {
              functionCalling: true,
              vision: false,
              responseSchema: false,
              reasoning: false,
              webSearch: true,
              codeExecution: false,
              pdfInput: false
            }
          }
        }
      }
    )
    expect(rows[0].metadata?.capabilities).toEqual({
      functionCalling: true, // from LiteLLM, no live signal for this field
      vision: true, // live wins over LiteLLM's false
      responseSchema: false,
      reasoning: false,
      webSearch: true, // from LiteLLM, no live signal for this field
      codeExecution: true, // live only (LiteLLM never has this field)
      pdfInput: false
    })
  })

  it('builds a real metadata object from a live capability patch alone, when LiteLLM has no entry', () => {
    const rows = buildModelRows(
      [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-new-model',
              label: 'Claude New Model',
              custom: false,
              enabled: true,
              liveOnly: false,
              liveCapabilities: { vision: true }
            }
          ]
        }
      ],
      providers,
      {}
    )
    expect(rows[0].metadata).toEqual({
      mode: 'other',
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      capabilities: {
        functionCalling: false,
        vision: true,
        responseSchema: false,
        reasoning: false,
        webSearch: false,
        codeExecution: false,
        pdfInput: false
      }
    })
  })
})

describe('CAPABILITY_LABEL', () => {
  it('has a human label for codeExecution and pdfInput', () => {
    expect(CAPABILITY_LABEL.codeExecution).toBe('Code execution')
    expect(CAPABILITY_LABEL.pdfInput).toBe('PDF input')
  })
})
