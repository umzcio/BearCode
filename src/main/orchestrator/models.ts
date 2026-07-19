// LangChain chat model factory, backed by the encrypted key vault.
// Never hardcode keys and never route through the Vercel AI Gateway;
// each provider is instantiated directly with the user's own key.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI, ChatOpenAICompletions, ChatOpenAIResponses } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { BearcodeChatOllama } from './ollamaCompat'
import { getKey } from '../keys'
import { getSettings } from '../settings'
import { parseModelRef, capabilitiesFor } from '../providers/registry'
import { webSearchCapability } from '../../shared/effort'
import type { EffortLevel, ProviderId } from '../../shared/types'

// Perplexity's Chat Completions endpoint rejects any request that carries a
// `tools` array ("400 Tool calling is not supported for this model") -- its
// sonar models do their web search server-side instead of calling client
// tools. The agent loop (deepagents) unconditionally bindTools()s the main
// model, so a plain ChatOpenAI pointed at Perplexity 400s on every turn.
// No-op the bind: the model never sees the tools, the loop runs it as a
// plain answer-with-built-in-search model, and everything downstream
// (streaming, usage, checkpoints) is unchanged. Extends ChatOpenAICompletions
// (not ChatOpenAI): Perplexity speaks ONLY the Chat Completions API, and only
// the Completions class exposes the overridable raw-response conversion hooks
// (they do not exist on ChatOpenAI's prototype at runtime -- verified).
// Exported for tests.
export class ToollessChatOpenAI extends ChatOpenAICompletions {
  override bindTools(): this {
    return this
  }

  // Perplexity returns its web sources as TOP-LEVEL response fields
  // (`citations`: url strings; `search_results`: {title,url,date}) that the
  // stock OpenAI converters drop. Copy them onto response_metadata so the
  // stream loop (graph.ts citationsFromMetadata) can surface them on
  // turn_meta.citations.
  override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions['_convertCompletionsDeltaToBaseMessageChunk']>
  ): ReturnType<ChatOpenAICompletions['_convertCompletionsDeltaToBaseMessageChunk']> {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(...args)
    attachSearchCitations(chunk, args[1])
    return chunk
  }

  override _convertCompletionsMessageToBaseMessage(
    ...args: Parameters<ChatOpenAICompletions['_convertCompletionsMessageToBaseMessage']>
  ): ReturnType<ChatOpenAICompletions['_convertCompletionsMessageToBaseMessage']> {
    const msg = super._convertCompletionsMessageToBaseMessage(...args)
    attachSearchCitations(msg, args[1])
    return msg
  }
}

// xAI's plain Chat Completions path (Web Search toggle OFF). Server-side
// search lives on xAI's Agent Tools API (/v1/responses, OpenAI-Responses-
// compatible) -- their completions-side live_search returned a live 410
// "deprecated, switch to the Agent Tools API" on 2026-07-19, so the search-on
// path constructs OpenAISearchChat with useResponsesApi instead (makeModel).
// This class only keeps the Live Search citation capture hooks for responses
// that carry a top-level `citations` field.
export class XaiChatOpenAI extends ChatOpenAICompletions {
  override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions['_convertCompletionsDeltaToBaseMessageChunk']>
  ): ReturnType<ChatOpenAICompletions['_convertCompletionsDeltaToBaseMessageChunk']> {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(...args)
    attachSearchCitations(chunk, args[1])
    return chunk
  }

  override _convertCompletionsMessageToBaseMessage(
    ...args: Parameters<ChatOpenAICompletions['_convertCompletionsMessageToBaseMessage']>
  ): ReturnType<ChatOpenAICompletions['_convertCompletionsMessageToBaseMessage']> {
    const msg = super._convertCompletionsMessageToBaseMessage(...args)
    attachSearchCitations(msg, args[1])
    return msg
  }
}

// The delta hook returns a message chunk; the non-streaming hook returns a
// message. Both carry response_metadata. rawResponse is the full parsed API
// payload (per-SSE-chunk when streaming), where Perplexity's/xAI's fields live.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachSearchCitations(target: any, rawResponse: unknown): void {
  const raw = rawResponse as { citations?: unknown; search_results?: unknown } | undefined
  const msg = target && typeof target === 'object' && 'message' in target ? target.message : target
  if (!msg || !raw) return
  const citations = raw.citations
  const searchResults = raw.search_results
  if (!Array.isArray(citations) && !Array.isArray(searchResults)) return
  msg.response_metadata = {
    ...(msg.response_metadata ?? {}),
    ...(Array.isArray(citations) ? { citations } : {}),
    ...(Array.isArray(searchResults) ? { search_results: searchResults } : {})
  }
}

// Anthropic's server-side web_search tool (executed by Anthropic, billed per
// search). Appended at the invocationParams chokepoint like xAI's server
// tools, so it rides both agent turns (alongside deepagents' bound client
// tools) and bare invokes. Gated on the per-conversation Web Search toggle
// (makeModel sets bearcodeWebSearch only when the toggle is on).
const ANTHROPIC_WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }
export class AnthropicSearchChat extends ChatAnthropic {
  bearcodeWebSearch = false
  override invocationParams(
    ...args: Parameters<ChatAnthropic['invocationParams']>
  ): ReturnType<ChatAnthropic['invocationParams']> {
    const params = super.invocationParams(...args)
    if (!this.bearcodeWebSearch) return params
    const existing = Array.isArray(params.tools) ? params.tools : []
    const has = existing.some(
      (t) => t && typeof t === 'object' && (t as { name?: string }).name === 'web_search'
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!has) params.tools = [...existing, ANTHROPIC_WEB_SEARCH as any]
    return params
  }
}

// Responses-API built-in server tools, same toggle + chokepoint pattern.
// Used for OpenAI reasoning models (web_search) AND for xAI's Agent Tools API
// (web_search + x_search -- xAI's /v1/responses is OpenAI-Responses-compatible;
// their completions-side live_search was deprecated with a live 410 on
// 2026-07-19). Extends ChatOpenAIResponses DIRECTLY: ChatOpenAI generates
// through an internal `this.responses` delegate whose invocationParams a
// ChatOpenAI subclass override never intercepts (verified in the dist --
// index.cjs:567,583) -- overriding on the Responses class itself is the only
// seam that actually reaches the wire.
export class OpenAISearchChat extends ChatOpenAIResponses {
  bearcodeWebSearch = false
  bearcodeSearchTools: { type: string }[] = [{ type: 'web_search' }]
  override invocationParams(
    ...args: Parameters<ChatOpenAIResponses['invocationParams']>
  ): ReturnType<ChatOpenAIResponses['invocationParams']> {
    const params = super.invocationParams(...args)
    if (!this.bearcodeWebSearch) return params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any
    const existing = Array.isArray(p.tools) ? p.tools : []
    const present = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      existing.map((t: any) => (t && typeof t === 'object' ? t.type : undefined))
    )
    p.tools = [...existing, ...this.bearcodeSearchTools.filter((t) => !present.has(t.type))]
    return params
  }
}

function requireKey(provider: ProviderId): string {
  const key = getKey(provider)
  if (!key) throw new Error(`No API key for ${provider}. Add it in Settings.`)
  return key
}

// Provider-specific constructor fragments for effort + thinking, kept PURE so
// the mapping is unit-tested without instantiating a LangChain class. Merged
// into the constructor args by makeModel. With opts omitted the result is
// byte-identical to the pre-E6 behavior (Anthropic/Google thinking on, effort
// unset). See planning/2026-07-05-e1e6-effort-composer-design.md §5.
//
// Haiku models don't support extended thinking; everything else gets adaptive
// thinking, mirroring the provider registry's providerOptions() for the legacy engine.
// display:'summarized' is required for reasoning to be visible: on Claude 4.6+
// models the raw chain of thought is never returned and the display defaults to
// 'omitted' (empty thinking text) -- without this the thinking blocks arrive with
// only a signature and no text, so the reasoning bridge (graph.ts) has nothing to
// show. 'summarized' returns a readable summary the bridge renders as "Thought for Ns".
//
// Gemini 2.5+ / 3.x models support thought summaries via thinkingConfig
// (`GoogleGenerativeAIThinkingConfig` in @langchain/google-genai's types.d.ts).
// Older 1.x models don't support thinking and error if this is set, so guard
// on model id, mirroring the Haiku exclusion above and the legacy engine's
// providerOptions() in src/main/providers/registry.ts.
// BearCode's EffortLevel has no direct OpenAI equivalent for 'adaptive' or
// 'max' -- OpenAI's own docs say reasoning models default to 'medium', so
// 'adaptive' maps there; 'max' maps to OpenAI's highest real tier, 'xhigh'.
function mapEffortToOpenAIReasoning(effort: EffortLevel): 'low' | 'medium' | 'high' | 'xhigh' {
  switch (effort) {
    case 'adaptive':
      return 'medium'
    case 'max':
      return 'xhigh'
    default:
      return effort
  }
}

export function buildModelExtras(
  provider: ProviderId,
  modelId: string,
  opts: { effort?: EffortLevel; thinking?: boolean }
): Record<string, unknown> {
  const effort = opts.effort ?? 'adaptive'
  const thinking = opts.thinking ?? true
  switch (provider) {
    case 'anthropic': {
      if (modelId.startsWith('claude-haiku')) return {} // never thinks; no effort
      const extras: Record<string, unknown> = {}
      if (thinking) extras.thinking = { type: 'adaptive', display: 'summarized' }
      if (effort !== 'adaptive') extras.outputConfig = { effort }
      return extras
    }
    case 'google':
      if (/^gemini-1[.-]/.test(modelId)) return {}
      return thinking ? { thinkingConfig: { includeThoughts: true } } : {}
    case 'ollama':
      return { think: thinking }
    case 'openai': {
      // No separate thinking knob (folded into effort).
      const caps = capabilitiesFor(`${provider}/${modelId}`)
      if (!caps?.reasoning) return {}
      const requestedEffort = opts.effort ?? caps.reasoning.effort
      // OpenAI's Chat Completions endpoint rejects reasoning_effort outright
      // whenever function tools are present ("400 Function tools with
      // reasoning_effort are not supported for <model> in /v1/chat/completions.
      // To use function tools, use /v1/responses or set reasoning_effort to
      // 'none'.") -- confirmed live. BearCode's agent always binds its full
      // toolset, so reasoning + tools can only coexist via the Responses API;
      // forcing it here is the only way GPT-5.6's reasoning is ever actually
      // usable in this app, not an optional knob.
      return {
        reasoning: { effort: mapEffortToOpenAIReasoning(requestedEffort) },
        useResponsesApi: true
      }
    }
    case 'xai': {
      // grok-4.20-multi-agent takes `agent_count` INSTEAD of reasoning_effort
      // (docs.x.ai multi-agent): the effort picker controls how many parallel
      // research agents xAI spins up server-side -- low/medium = 4, high and
      // above = 16. Other Grok models take no effort knob (default {}).
      const caps = capabilitiesFor(`${provider}/${modelId}`)
      if (!caps?.reasoning) return {}
      const requestedEffort = opts.effort ?? caps.reasoning.effort
      const agentCount =
        requestedEffort === 'high' || requestedEffort === 'xhigh' || requestedEffort === 'max'
          ? 16
          : 4
      return { modelKwargs: { agent_count: agentCount } }
    }
    default:
      // openrouter: no first-party reasoning-capable models curated today
      // (capabilitiesFor returns null for every openrouter ref), and
      // OpenRouter's OpenAI-compatible endpoint doesn't speak the Responses
      // API -- never force it on here even if that changes.
      return {}
  }
}

export function makeModel(
  modelRef: string,
  opts: { effort?: EffortLevel; thinking?: boolean; webSearch?: boolean } = {}
): BaseChatModel {
  const { provider, modelId } = parseModelRef(modelRef)
  const extras = buildModelExtras(provider, modelId, opts)
  // Per-conversation Web Search toggle, enforced main-side regardless of what
  // the renderer claims: only providers whose capability is 'toggle' honor it
  // (shared/effort.ts webSearchCapability is the single source of truth).
  const search = opts.webSearch === true && webSearchCapability(modelRef) === 'toggle'
  switch (provider) {
    case 'anthropic': {
      const m = new AnthropicSearchChat({
        apiKey: requireKey('anthropic'),
        model: modelId,
        ...extras
      })
      m.bearcodeWebSearch = search
      return m
    }
    case 'openai': {
      if (search) {
        // OpenAISearchChat IS the Responses implementation; the
        // useResponsesApi flag in extras is meaningless to it (dropped).
        const { useResponsesApi: _drop, ...rest } = extras
        void _drop
        const m = new OpenAISearchChat({ apiKey: requireKey('openai'), model: modelId, ...rest })
        m.bearcodeWebSearch = true
        return m
      }
      return new ChatOpenAI({ apiKey: requireKey('openai'), model: modelId, ...extras })
    }
    case 'google':
      return new ChatGoogleGenerativeAI({ apiKey: requireKey('google'), model: modelId, ...extras })
    case 'openrouter':
      return new ChatOpenAI({
        apiKey: requireKey('openrouter'),
        model: modelId,
        configuration: { baseURL: 'https://openrouter.ai/api/v1' },
        ...extras
      })
    case 'perplexity':
      // Perplexity is an OpenAI-compatible Chat Completions endpoint. Same
      // pattern as openrouter: ChatOpenAI + a baseURL override. NEVER
      // useResponsesApi -- the endpoint doesn't speak the Responses API
      // (buildModelExtras returns {} for it via the default branch).
      return new ToollessChatOpenAI({
        apiKey: requireKey('perplexity'),
        model: modelId,
        configuration: { baseURL: 'https://api.perplexity.ai' },
        ...extras
      })
    case 'xai': {
      // Grok has real function calling, so client tools stay bound. Two paths:
      // - Web Search ON: xAI's Agent Tools API (/v1/responses, OpenAI-
      //   Responses-compatible) with the web_search + x_search built-ins --
      //   the ONLY place server-side search still lives (completions
      //   live_search 410'd as deprecated, verified live 2026-07-19).
      // - OFF: plain Chat Completions (XaiChatOpenAI keeps the citation hooks).
      if (search) {
        const m = new OpenAISearchChat({
          apiKey: requireKey('xai'),
          model: modelId,
          configuration: { baseURL: 'https://api.x.ai/v1' },
          ...extras
        })
        m.bearcodeWebSearch = true
        m.bearcodeSearchTools = [{ type: 'web_search' }, { type: 'x_search' }]
        return m
      }
      return new XaiChatOpenAI({
        apiKey: requireKey('xai'),
        model: modelId,
        configuration: { baseURL: 'https://api.x.ai/v1' },
        ...extras
      })
    }
    case 'ollama':
      // BearcodeChatOllama stringifies non-string tool-message content that
      // upstream ChatOllama rejects (see ollamaCompat.ts).
      return new BearcodeChatOllama({ baseUrl: getSettings().ollamaBaseUrl, model: modelId, ...extras })
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}
