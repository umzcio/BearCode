// LangChain chat model factory, backed by the encrypted key vault.
// Never hardcode keys and never route through the Vercel AI Gateway;
// each provider is instantiated directly with the user's own key.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { BearcodeChatOllama } from './ollamaCompat'
import { getKey } from '../keys'
import { getSettings } from '../settings'
import { parseModelRef, capabilitiesFor } from '../providers/registry'
import type { EffortLevel, ProviderId } from '../../shared/types'

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
  opts: { effort?: EffortLevel; thinking?: boolean } = {}
): BaseChatModel {
  const { provider, modelId } = parseModelRef(modelRef)
  const extras = buildModelExtras(provider, modelId, opts)
  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({ apiKey: requireKey('anthropic'), model: modelId, ...extras })
    case 'openai':
      return new ChatOpenAI({ apiKey: requireKey('openai'), model: modelId, ...extras })
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
      return new ChatOpenAI({
        apiKey: requireKey('perplexity'),
        model: modelId,
        configuration: { baseURL: 'https://api.perplexity.ai' },
        ...extras
      })
    case 'ollama':
      // BearcodeChatOllama stringifies non-string tool-message content that
      // upstream ChatOllama rejects (see ollamaCompat.ts).
      return new BearcodeChatOllama({ baseUrl: getSettings().ollamaBaseUrl, model: modelId, ...extras })
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}
