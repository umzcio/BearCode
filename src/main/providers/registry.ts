// Provider registry: curated model lists + provider metadata (display
// name, color, key requirement). Model CONSTRUCTION lives in
// orchestrator/models.ts's makeModel() (LangChain-based) -- this file is
// pure data/config, no LLM client code.
import type {
  CustomModel,
  ManageableModel,
  ManageableProvider,
  ModelCapabilities,
  ModelInfo,
  ProviderId,
  ProviderModels
} from '../../shared/types'
import { keyStatus } from '../keys'
import { getSettings } from '../settings'

interface ProviderRegistryEntry {
  id: ProviderId
  displayName: string
  color: string
  requiresKey: boolean
  listModels(): Promise<{ models: ModelInfo[]; reachable: boolean; note?: string }>
}

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 }
]

export const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_050_000 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 1_050_000 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 1_050_000 }
]

export const GOOGLE_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000 }
]

// Curated popular subset; live discovery of the full catalog lands in Phase 6.
export const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  { id: 'moonshotai/kimi-k2', label: 'Kimi K2' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }
]

// Ursa Phase 1: static per-model metadata, keyed by "provider/modelId". Drives
// both the GPT-5.6 reasoning.effort fix (models.ts's buildModelExtras) and the
// Ursa classifier's model knowledge. Data only -- no LLM client code here.
const CAPABILITIES: Record<string, ModelCapabilities> = {
  'anthropic/claude-fable-5': {
    strengths: ['code', 'research', 'writing', 'general'],
    costTier: 'high'
  },
  'anthropic/claude-opus-4-8': {
    strengths: ['code', 'research', 'writing', 'general'],
    costTier: 'high'
  },
  'anthropic/claude-sonnet-5': {
    strengths: ['code', 'writing', 'general'],
    costTier: 'mid'
  },
  'anthropic/claude-haiku-4-5': {
    strengths: ['general'],
    costTier: 'low'
  },
  'openai/gpt-5.6-sol': {
    reasoning: { effort: 'high' },
    strengths: ['code', 'general'],
    costTier: 'high'
  },
  'openai/gpt-5.6-terra': {
    reasoning: { effort: 'medium' },
    strengths: ['writing', 'general'],
    costTier: 'mid'
  },
  'openai/gpt-5.6-luna': {
    reasoning: { effort: 'medium' },
    strengths: ['code', 'general'],
    costTier: 'low'
  },
  'google/gemini-3.1-pro-preview': {
    strengths: ['research', 'long-context', 'general'],
    costTier: 'high'
  },
  'google/gemini-2.5-pro': {
    strengths: ['research', 'long-context'],
    costTier: 'mid'
  },
  'google/gemini-2.5-flash': {
    strengths: ['general'],
    costTier: 'low'
  }
}

// Static capability lookup for a "provider/modelId" ref. Returns null for any
// ref not in the curated table above (custom models, Ollama, OpenRouter) --
// callers (buildModelExtras, the Ursa classifier) must treat null as "no
// special handling," never throw.
export function capabilitiesFor(ref: string): ModelCapabilities | null {
  return CAPABILITIES[ref] ?? null
}

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
    listModels: async () => ({ models: ANTHROPIC_MODELS, reachable: true })
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    listModels: async () => ({ models: OPENAI_MODELS, reachable: true })
  },
  {
    id: 'google',
    displayName: 'Google',
    color: '#4c8dff',
    requiresKey: true,
    listModels: async () => ({ models: GOOGLE_MODELS, reachable: true })
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    color: '#b58cff',
    requiresKey: true,
    listModels: async () => ({ models: OPENROUTER_MODELS, reachable: true })
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    listModels: listOllamaModels
  }
]

// F7 — the effective model set for a provider: curated + custom (custom wins on
// id collision), minus any refs the user opted out of. Pure: takes the custom
// and disabled sets explicitly so it is trivially unit-testable and every reader
// (listAllModels, allKnownModelRefs, contextWindowFor) resolves the SAME set.
export function mergeModels(
  provider: ProviderId,
  curated: ModelInfo[],
  custom: CustomModel[],
  disabled: string[]
): ModelInfo[] {
  const disabledSet = new Set(disabled)
  const byId = new Map<string, ModelInfo>()
  for (const m of curated) byId.set(m.id, m)
  for (const c of custom) {
    if (c.provider === provider) {
      byId.set(c.id, { id: c.id, label: c.label, contextWindow: c.contextWindow })
    }
  }
  return [...byId.values()].filter((m) => !disabledSet.has(`${provider}/${m.id}`))
}

// The first-party curated providers subject to opt-out + Add-model. Ollama is
// excluded: it is fully dynamic/local and manages its own catalog.
const MANAGEABLE: { id: ProviderId; models: ModelInfo[] }[] = [
  { id: 'anthropic', models: ANTHROPIC_MODELS },
  { id: 'openai', models: OPENAI_MODELS },
  { id: 'google', models: GOOGLE_MODELS },
  { id: 'openrouter', models: OPENROUTER_MODELS }
]

// Every "providerId/modelId" ref in the EFFECTIVE set (curated + custom minus
// disabled) for the first-party + OpenRouter providers. Feeds the LiteLLM
// pricing sync. Ollama is dynamic/local and free, so it is intentionally
// excluded.
export function allKnownModelRefs(): string[] {
  const { customModels = [], disabledModels = [] } = getSettings()
  return MANAGEABLE.flatMap(({ id, models }) =>
    mergeModels(id, models, customModels, disabledModels).map((m) => `${id}/${m.id}`)
  )
}

// The Models settings page's management list: curated + custom per first-party
// provider, INCLUDING disabled models (with an `enabled` flag) so the user can
// toggle them back on. Distinct from listAllModels, which returns only the
// visible/effective set for the pickers.
export function listManageableModels(): ManageableProvider[] {
  const { customModels = [], disabledModels = [] } = getSettings()
  const disabledSet = new Set(disabledModels)
  return MANAGEABLE.map(({ id, models }) => {
    const entry = getProvider(id)
    const byId = new Map<string, ManageableModel>()
    for (const m of models) {
      byId.set(m.id, {
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow,
        custom: false,
        enabled: !disabledSet.has(`${id}/${m.id}`)
      })
    }
    for (const c of customModels) {
      if (c.provider === id) {
        byId.set(c.id, {
          id: c.id,
          label: c.label,
          contextWindow: c.contextWindow,
          custom: true,
          enabled: !disabledSet.has(`${id}/${c.id}`)
        })
      }
    }
    return { id, displayName: entry.displayName, color: entry.color, models: [...byId.values()] }
  })
}

export function getProvider(id: ProviderId): ProviderRegistryEntry {
  const entry = REGISTRY.find((p) => p.id === id)
  if (!entry) throw new Error(`Unknown provider: ${id}`)
  return entry
}

// Static curated context windows per provider, keyed for a synchronous lookup
// (the summarizer trigger needs the real window at agent-build time). Ollama
// and the curated OpenRouter subset carry no window and resolve to `null`.
const STATIC_MODELS: Partial<Record<ProviderId, ModelInfo[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  openrouter: OPENROUTER_MODELS
}

// The model's real context window (tokens) for a "provider/modelId" ref, or
// `null` when unknown (Ollama, OpenRouter, or an id absent from the curated
// list). Never throws for an unknown model id — only an unparseable ref does.
export function contextWindowFor(ref: string): number | null {
  const { provider, modelId } = parseModelRef(ref)
  // A custom model wins on id collision (F7 invariant, matching mergeModels): the
  // user may deliberately override a curated id with a smaller window (a lower-
  // tier deployment). Check custom FIRST so the summarizer compacts against the
  // real window, not the curated one.
  const custom = (getSettings().customModels ?? []).find(
    (c) => c.provider === provider && c.id === modelId
  )
  if (custom) return custom.contextWindow
  const info = STATIC_MODELS[provider]?.find((m) => m.id === modelId)
  return info?.contextWindow ?? null
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
  const { customModels = [], disabledModels = [] } = getSettings()
  return Promise.all(
    REGISTRY.map(async (entry) => {
      const { models, reachable, note } = await entry.listModels()
      // Return the effective set: curated/dynamic + custom, minus opted-out refs
      // (F7). Every picker/meter/pricing consumer reads this, staying consistent.
      const merged = mergeModels(entry.id, models, customModels, disabledModels)
      return {
        id: entry.id,
        displayName: entry.displayName,
        color: entry.color,
        requiresKey: entry.requiresKey,
        keyConfigured: entry.requiresKey ? status[entry.id] : true,
        reachable,
        models: merged,
        note
      }
    })
  )
}
