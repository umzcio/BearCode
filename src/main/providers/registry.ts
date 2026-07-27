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
import { getKey, keyStatus } from '../keys'
import { getSettings } from '../settings'
import type { ModelMetadata } from '../../shared/pricing'
import { fetchAnthropicModels, fetchGoogleModels, fetchOpenAIModels } from './liveDiscovery'

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
// Context windows verified against openrouter.ai per-model pages, 2026-07-20.
export const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', contextWindow: 131_072 },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3', contextWindow: 1_048_576 },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', contextWindow: 1_000_000 },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3', contextWindow: 1_000_000 }
]

// Perplexity's Sonar family (verified against docs.perplexity.ai, 2026-07).
// Web-grounded chat models; deep-research is intentionally excluded (slow and
// specialized, a poor fit for interactive routing).
export const PERPLEXITY_MODELS: ModelInfo[] = [
  { id: 'sonar', label: 'Sonar', contextWindow: 128_000 },
  { id: 'sonar-pro', label: 'Sonar Pro', contextWindow: 200_000 },
  { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', contextWindow: 128_000 }
]

// xAI's Grok family (verified against docs.x.ai, 2026-07). Grok has real
// function calling, unlike Perplexity's Sonar models -- makeModel uses plain
// ChatOpenAI for xai, not ToollessChatOpenAI.
export const XAI_MODELS: ModelInfo[] = [
  { id: 'grok-4.5', label: 'Grok 4.5', contextWindow: 500_000 },
  { id: 'grok-4.20-multi-agent', label: 'Grok 4.20 Multi-Agent', contextWindow: 2_000_000 },
  { id: 'grok-4.3', label: 'Grok 4.3', contextWindow: 1_000_000 },
  { id: 'grok-4-fast', label: 'Grok 4 Fast', contextWindow: 2_000_000 }
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
  },
  'perplexity/sonar': {
    strengths: ['research', 'general'],
    costTier: 'low'
  },
  'perplexity/sonar-pro': {
    strengths: ['research', 'general'],
    costTier: 'mid'
  },
  'perplexity/sonar-reasoning-pro': {
    strengths: ['research'],
    costTier: 'mid'
  },
  'xai/grok-4.5': {
    strengths: ['code', 'general'],
    costTier: 'high'
  },
  // Realtime multi-agent research: xAI spins up parallel server-side agents
  // that search, cross-reference, and synthesize with citations. The
  // `reasoning` entry marks it effort-capable -- BearCode's effort picker maps
  // onto agent_count (buildModelExtras xai case: low/medium=4, high+=16).
  'xai/grok-4.20-multi-agent': {
    reasoning: { effort: 'medium' },
    strengths: ['research', 'general', 'long-context'],
    costTier: 'high'
  },
  'xai/grok-4.3': {
    strengths: ['general', 'long-context'],
    costTier: 'mid'
  },
  'xai/grok-4-fast': {
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

// /api/tags carries no context window, so an Ollama model's window has to come
// from /api/show, which reports it under an ARCHITECTURE-prefixed key
// ("qwen35moe.context_length", "llama.context_length", ...). The architecture is
// also in model_info as general.architecture, but matching any *.context_length
// key is strictly more robust and costs nothing. Ollama does not guarantee the
// field exists for every model, so a miss is normal -> undefined, not an error.
export function contextLengthFromShow(payload: unknown): number | undefined {
  const info = (payload as { model_info?: Record<string, unknown> } | null)?.model_info
  if (!info) return undefined
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value
  }
  return undefined
}

// One /api/show round trip per model is far too expensive to repeat on every
// listing (listOllamaModels runs per-turn via eligibleUrsusRoles). A model's
// context length is immutable for a given pulled tag, so cache it for the
// process lifetime and only ever fetch each id once.
const ollamaContextWindows = new Map<string, number | undefined>()

async function fetchOllamaContextWindow(base: string, id: string): Promise<number | undefined> {
  if (ollamaContextWindows.has(id)) return ollamaContextWindows.get(id)
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const win = contextLengthFromShow(await res.json())
    ollamaContextWindows.set(id, win)
    return win
  } catch {
    // Do NOT cache a failure: a transient error should not permanently mark the
    // model as window-less for the rest of the session.
    return undefined
  }
}

// `withContextWindows` is opt-in because it costs one extra request per model.
// Callers that only need the model LIST (per-turn eligibility checks) leave it
// off and keep the single-request fast path; the catalog that feeds the
// renderer (and therefore the context meter) turns it on.
export async function listOllamaModels(
  opts: { withContextWindows?: boolean } = {}
): Promise<{
  models: ModelInfo[]
  reachable: boolean
  note?: string
}> {
  const base = getSettings().ollamaBaseUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { models?: { name: string }[] }
    const names = (data.models ?? []).map((m) => m.name)
    if (!opts.withContextWindows) {
      return { models: names.map((id) => ({ id, label: id })), reachable: true }
    }
    const models = await Promise.all(
      names.map(async (id) => {
        const contextWindow = await fetchOllamaContextWindow(base, id)
        return { id, label: id, ...(contextWindow ? { contextWindow } : {}) }
      })
    )
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
    listModels: async () => {
      await ensureLiveDiscovery('anthropic')
      return { models: knownModels('anthropic'), reachable: true }
    }
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    listModels: async () => {
      await ensureLiveDiscovery('openai')
      return { models: knownModels('openai'), reachable: true }
    }
  },
  {
    id: 'google',
    displayName: 'Google',
    color: '#4c8dff',
    requiresKey: true,
    listModels: async () => {
      await ensureLiveDiscovery('google')
      return { models: knownModels('google'), reachable: true }
    }
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    color: '#b58cff',
    requiresKey: true,
    listModels: async () => ({ models: OPENROUTER_MODELS, reachable: true })
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    color: '#20B8CD',
    requiresKey: true,
    listModels: async () => ({ models: PERPLEXITY_MODELS, reachable: true })
  },
  {
    id: 'xai',
    displayName: 'xAI',
    color: '#9aa0a6',
    requiresKey: true,
    listModels: async () => ({ models: XAI_MODELS, reachable: true })
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    // The catalog path feeds the renderer (model picker, context meter, pricing),
    // so it pays the extra /api/show round trip per model to learn each one's
    // context window. Per-turn eligibility checks call listOllamaModels()
    // directly, without the flag, and keep the single-request fast path.
    listModels: () => listOllamaModels({ withContextWindows: true })
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
// excluded: it is fully dynamic/local and manages its own catalog. Anthropic/
// Google/OpenAI's entries in knownModels() may be live-discovered (Task 6);
// openrouter/perplexity/xai always resolve to their static array (no
// discovery mechanism exists for any of them).
const MANAGEABLE_PROVIDER_IDS: ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'perplexity',
  'xai'
]

// Whether a model id is a live-discovery-only entry for this provider: not in
// the shipped STATIC_MODELS array, and not a user's custom model (custom
// always wins on id collision — see mergeModels' own comment). Used to decide
// which opt policy (opt-in enabledLiveModels vs. opt-out disabledModels)
// governs a given ref. Keep this the ONLY place that computes liveOnly so
// listManageableModels (the Models page) and listAllModels/allKnownModelRefs
// (the picker + pricing sync) can never resolve a different answer for the
// same ref.
export function isLiveOnly(provider: ProviderId, modelId: string, custom: CustomModel[]): boolean {
  if (custom.some((c) => c.provider === provider && c.id === modelId)) return false
  return !(STATIC_MODELS[provider] ?? []).some((m) => m.id === modelId)
}

// Every "providerId/modelId" ref in the EFFECTIVE set (curated + custom minus
// disabled, PLUS the enabledLiveModels opt-in filter for live-only entries)
// for the first-party + OpenRouter providers. Feeds the LiteLLM pricing sync.
// Ollama is dynamic/local and free, so it is intentionally excluded.
export function allKnownModelRefs(): string[] {
  const { customModels = [], disabledModels = [], enabledLiveModels = [] } = getSettings()
  const enabledLiveSet = new Set(enabledLiveModels)
  return MANAGEABLE_PROVIDER_IDS.flatMap((id) =>
    mergeModels(id, knownModels(id), customModels, disabledModels)
      .filter((m) => !isLiveOnly(id, m.id, customModels) || enabledLiveSet.has(`${id}/${m.id}`))
      .map((m) => `${id}/${m.id}`)
  )
}

// The Models settings page's management list: curated/live + custom per
// first-party provider, INCLUDING disabled models (with an `enabled` flag)
// so the user can toggle them back on. Distinct from listAllModels, which
// returns only the visible/effective set for the pickers. Async since Task
// 6 has this trigger live discovery for anthropic/google/openai the first
// time it (or listAllModels) is called this process lifetime.
export async function listManageableModels(): Promise<ManageableProvider[]> {
  await Promise.all(
    (['anthropic', 'google', 'openai'] as ProviderId[]).map((id) => ensureLiveDiscovery(id))
  )
  const { customModels = [], disabledModels = [], enabledLiveModels = [] } = getSettings()
  const disabledSet = new Set(disabledModels)
  const enabledLiveSet = new Set(enabledLiveModels)
  return MANAGEABLE_PROVIDER_IDS.map((id) => {
    const entry = getProvider(id)
    const models = knownModels(id)
    const byId = new Map<string, ManageableModel>()
    for (const m of models) {
      const ref = `${id}/${m.id}`
      const liveOnly = isLiveOnly(id, m.id, customModels)
      const liveCapabilities = liveCapabilitiesFor(ref)
      byId.set(m.id, {
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow,
        custom: false,
        liveOnly,
        enabled: liveOnly ? enabledLiveSet.has(ref) : !disabledSet.has(ref),
        ...(liveCapabilities ? { liveCapabilities } : {})
      })
    }
    for (const c of customModels) {
      if (c.provider === id) {
        byId.set(c.id, {
          id: c.id,
          label: c.label,
          contextWindow: c.contextWindow,
          custom: true,
          liveOnly: false,
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
  openrouter: OPENROUTER_MODELS,
  perplexity: PERPLEXITY_MODELS,
  xai: XAI_MODELS
}

// Per-provider live-discovered model list (Anthropic/Google/OpenAI only --
// see liveDiscovery.ts), populated lazily by ensureLiveDiscovery(). Empty
// until that provider's first successful live fetch this process lifetime;
// knownModels() falls back to STATIC_MODELS for any provider with no cache
// entry -- every provider, until Task 6 wires in the real fetchers, and
// permanently for xAI/Perplexity/OpenRouter (no discovery mechanism exists).
const liveModelCache = new Map<ProviderId, ModelInfo[]>()

// Per-ref live-discovered capability patch. Merged on top of LiteLLM's
// persisted AppSettings.modelMetadata at render time by buildModelRows
// (Task 7) -- never itself persisted to settings.
const liveCapabilityCache = new Map<string, Partial<ModelMetadata['capabilities']>>()

// The current best-known model list for a provider: live-discovered if a
// successful fetch has landed this process lifetime, else the static
// curated array. Synchronous and side-effect-free -- never triggers a
// fetch itself (that's ensureLiveDiscovery's job) -- safe to call from a
// hot path like contextWindowFor.
export function knownModels(provider: ProviderId): ModelInfo[] {
  return liveModelCache.get(provider) ?? STATIC_MODELS[provider] ?? []
}

export function liveCapabilitiesFor(ref: string): Partial<ModelMetadata['capabilities']> | undefined {
  return liveCapabilityCache.get(ref)
}

// Sync-metadata button (Models page header) calls this alongside its
// existing LiteLLM sync, so one action refreshes everything about a
// model's data. Clearing (rather than a "force" flag on
// ensureLiveDiscovery) is enough: the guard below is just "does this
// provider have a cache entry," and clearing removes it, making the next
// natural call re-fetch.
export function clearLiveDiscoveryCache(): void {
  liveModelCache.clear()
  liveCapabilityCache.clear()
}

// Merge a live-discovered list with the static curated array by id, PER
// FIELD -- never wholesale-replace a static entry with a live one. Several
// live sources omit fields the curated array carries (OpenAI's endpoint has
// no contextWindow at all; Anthropic/Google omit it whenever their payload's
// context field is 0/absent), so spreading `existing` first and `m` second
// means a field live doesn't provide falls through to the static value,
// while any field live DOES provide (id/label/a real contextWindow) still
// wins. For Anthropic/Google, live's label wins outright on collision (their
// APIs return a real display name). For OpenAI specifically, prefer the
// STATIC entry's label on collision -- OpenAI's list endpoint has no
// display-name field at all, so a raw id ("gpt-5.6-sol") is worse UX than a
// name we already have.
function mergeLiveWithStatic(
  live: ModelInfo[],
  staticModels: ModelInfo[],
  opts: { preferStaticLabel: boolean }
): ModelInfo[] {
  const staticById = new Map(staticModels.map((m) => [m.id, m]))
  const byId = new Map<string, ModelInfo>()
  for (const m of staticModels) byId.set(m.id, m)
  for (const m of live) {
    const existing = staticById.get(m.id)
    byId.set(m.id, {
      ...existing,
      ...m,
      label: opts.preferStaticLabel && existing ? existing.label : m.label
    })
  }
  return [...byId.values()]
}

// OpenAI's list has no mode/type field, so filter via the LiteLLM catalog
// this feature already syncs (mode === 'chat'). Bootstrap fallback only for
// the case LiteLLM hasn't been synced yet (nothing to cross-reference) --
// a known-imperfect substring blacklist, superseded automatically the first
// time the user hits "Sync metadata".
const OPENAI_NON_CHAT_SUBSTRINGS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'davinci-002',
  'babbage-002',
  'realtime',
  'audio',
  'image',
  'video',
  'computer-use',
  'codex'
]

function isKnownOpenAIChatModel(id: string, metadata: Record<string, { mode?: string }> | undefined): boolean {
  const ref = `openai/${id}`
  if (metadata?.[ref]) return metadata[ref].mode === 'chat'
  return !OPENAI_NON_CHAT_SUBSTRINGS.some((s) => id.includes(s))
}

// Idempotent per-provider live-discovery trigger. Whichever of
// listAllModels() (via REGISTRY[i].listModels()) or listManageableModels()
// runs first pays the network cost and warms the caches above for the
// rest of the process; every later call this session is a no-op (the
// guard is cache presence, not a separate "already tried" flag -- see
// clearLiveDiscoveryCache's comment for why a failed/no-key attempt is
// allowed to retry on the next call rather than being cached as a
// permanent negative result). No key configured -> bail out immediately
// with no fetch attempt at all, leaving knownModels() on the STATIC_MODELS
// fallback for that provider.
async function ensureLiveDiscovery(provider: ProviderId): Promise<void> {
  if (liveModelCache.has(provider)) return
  const apiKey = getKey(provider)
  if (!apiKey) return

  // Each fetcher (liveDiscovery.ts) already wraps its own body in try/catch
  // and resolves null rather than rejecting -- but this call site must not
  // implicitly depend on that invariant holding forever. A future change to
  // any fetcher that drops its own try/catch would otherwise reintroduce an
  // unhandled rejection here that breaks listAllModels/listManageableModels
  // entirely, undermining the "fail closed to the static array" premise this
  // whole feature is built on. Belt-and-suspenders: a thrown/rejected fetch
  // degrades to the exact same fallback as a `null` resolution.
  let result: Awaited<ReturnType<typeof fetchAnthropicModels>> = null
  try {
    if (provider === 'anthropic') result = await fetchAnthropicModels(apiKey)
    else if (provider === 'google') result = await fetchGoogleModels(apiKey)
    else if (provider === 'openai') {
      const metadata = getSettings().modelMetadata
      result = await fetchOpenAIModels(apiKey, (id) => isKnownOpenAIChatModel(id, metadata))
    }
  } catch {
    return
  }
  if (!result) return

  const merged = mergeLiveWithStatic(result.models, STATIC_MODELS[provider] ?? [], {
    preferStaticLabel: provider === 'openai'
  })
  liveModelCache.set(provider, merged)
  for (const [id, caps] of Object.entries(result.capabilities)) {
    liveCapabilityCache.set(`${provider}/${id}`, caps)
  }
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
  const info = knownModels(provider).find((m) => m.id === modelId)
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
  const { customModels = [], disabledModels = [], enabledLiveModels = [] } = getSettings()
  const enabledLiveSet = new Set(enabledLiveModels)
  return Promise.all(
    REGISTRY.map(async (entry) => {
      const { models, reachable, note } = await entry.listModels()
      // Return the effective set: curated/dynamic + custom, minus opted-out refs
      // (F7), further filtered so a live-only model only appears once the user
      // has opted it in via enabledLiveModels. Every picker/meter/pricing
      // consumer reads this, staying consistent with listManageableModels.
      // The opt-in filter only applies to MANAGEABLE_PROVIDER_IDS (the
      // providers with a STATIC_MODELS entry) -- Ollama has no STATIC_MODELS
      // key and is deliberately excluded from that set (fully dynamic/local,
      // manages its own catalog), so every id isLiveOnly() would resolve as
      // "live-only, not opted in" and there is no UI path to ever opt an
      // Ollama ref in (listManageableModels never iterates it either). Without
      // this guard, real locally-pulled Ollama models would silently vanish
      // from the picker/context meter.
      const merged = mergeModels(entry.id, models, customModels, disabledModels).filter(
        (m) =>
          !MANAGEABLE_PROVIDER_IDS.includes(entry.id) ||
          !isLiveOnly(entry.id, m.id, customModels) ||
          enabledLiveSet.has(`${entry.id}/${m.id}`)
      )
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
