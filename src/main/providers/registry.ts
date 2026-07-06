// Provider registry built on the Vercel AI SDK. Each provider is
// instantiated directly with the user's own key: never route through the
// Vercel AI Gateway. Curated model lists live here and are meant to be
// edited as the vendors ship new models.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { ModelInfo, ProviderId, ProviderModels } from '../../shared/types'
import { getKey, keyStatus } from '../keys'
import { getSettings } from '../settings'

interface ProviderRegistryEntry {
  id: ProviderId
  displayName: string
  color: string
  requiresKey: boolean
  make(modelId: string): LanguageModel
  listModels(): Promise<{ models: ModelInfo[]; reachable: boolean; note?: string }>
  // provider-specific options merged into streamText calls (thinking etc.)
  providerOptions?(modelId: string): ProviderOptions | undefined
}

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 }
]

const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-5.1', label: 'GPT-5.1', contextWindow: 400_000 },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', contextWindow: 400_000 },
  { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1_000_000 }
]

export const GOOGLE_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000 }
]

// Curated popular subset; live discovery of the full catalog lands in Phase 6.
export const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  { id: 'moonshotai/kimi-k2', label: 'Kimi K2' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }
]

async function listOllamaModels(): Promise<{
  models: ModelInfo[]
  reachable: boolean
  note?: string
}> {
  const base = getSettings().ollamaBaseUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { models?: { name: string }[] }
    const models = (data.models ?? []).map((m) => ({ id: m.name, label: m.name }))
    return { models, reachable: true }
  } catch {
    return { models: [], reachable: false, note: 'Ollama not running' }
  }
}

export const REGISTRY: ProviderRegistryEntry[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    color: '#d97757',
    requiresKey: true,
    make: (modelId) => createAnthropic({ apiKey: getKey('anthropic') })(modelId),
    listModels: async () => ({ models: ANTHROPIC_MODELS, reachable: true }),
    providerOptions: (modelId) =>
      // Claude 4.6+ models take adaptive thinking; Haiku 4.5 does not.
      modelId.startsWith('claude-haiku')
        ? undefined
        : { anthropic: { thinking: { type: 'adaptive' } } }
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    make: (modelId) => createOpenAI({ apiKey: getKey('openai') })(modelId),
    listModels: async () => ({ models: OPENAI_MODELS, reachable: true })
  },
  {
    id: 'google',
    displayName: 'Google',
    color: '#4c8dff',
    requiresKey: true,
    make: (modelId) => createGoogleGenerativeAI({ apiKey: getKey('google') })(modelId),
    listModels: async () => ({ models: GOOGLE_MODELS, reachable: true }),
    providerOptions: () => ({
      google: { thinkingConfig: { includeThoughts: true } }
    })
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    color: '#b58cff',
    requiresKey: true,
    make: (modelId) => createOpenRouter({ apiKey: getKey('openrouter') }).chat(modelId),
    listModels: async () => ({ models: OPENROUTER_MODELS, reachable: true })
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    make: (modelId) =>
      createOpenAICompatible({
        name: 'ollama',
        baseURL: `${getSettings().ollamaBaseUrl.replace(/\/$/, '')}/v1`
      })(modelId),
    listModels: listOllamaModels
  }
]

export function getProvider(id: ProviderId): ProviderRegistryEntry {
  const entry = REGISTRY.find((p) => p.id === id)
  if (!entry) throw new Error(`Unknown provider: ${id}`)
  return entry
}

export function parseModelRef(ref: string): { provider: ProviderId; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash < 1) throw new Error(`Invalid model ref: ${ref}`)
  const provider = ref.slice(0, slash) as ProviderId
  const modelId = ref.slice(slash + 1)
  getProvider(provider)
  return { provider, modelId }
}

// Whether a provider accepts a native PDF document block (D5 hybrid routing).
// True for the first-party providers whose LangChain client + endpoint accept
// a {type:'file'} block; false for OpenAI-*compatible* endpoints (OpenRouter,
// and any Kimi/other baseURL config, which format like OpenAI but the endpoint
// rejects file/input_file) and Ollama. Non-capable providers get the
// extract-to-text sidecar fallback, which is universally accepted.
export function supportsNativePdf(provider: ProviderId): boolean {
  return provider === 'anthropic' || provider === 'google' || provider === 'openai'
}

export async function listAllModels(): Promise<ProviderModels[]> {
  const status = keyStatus()
  return Promise.all(
    REGISTRY.map(async (entry) => {
      const { models, reachable, note } = await entry.listModels()
      return {
        id: entry.id,
        displayName: entry.displayName,
        color: entry.color,
        requiresKey: entry.requiresKey,
        keyConfigured: entry.requiresKey ? status[entry.id] : true,
        reachable,
        models,
        note
      }
    })
  )
}
