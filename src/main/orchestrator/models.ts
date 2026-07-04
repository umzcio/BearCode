// LangChain chat model factory, backed by the encrypted key vault.
// Never hardcode keys and never route through the Vercel AI Gateway;
// each provider is instantiated directly with the user's own key.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOllama } from '@langchain/ollama'
import { getKey } from '../keys'
import { getSettings } from '../settings'
import { parseModelRef } from '../ursa/providers/registry'
import type { ProviderId } from '../../shared/types'

function requireKey(provider: ProviderId): string {
  const key = getKey(provider)
  if (!key) throw new Error(`No API key for ${provider}. Add it in Settings.`)
  return key
}

export function makeModel(modelRef: string): BaseChatModel {
  const { provider, modelId } = parseModelRef(modelRef)
  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({
        apiKey: requireKey('anthropic'),
        model: modelId,
        // Haiku models don't support extended thinking; everything else gets adaptive
        // thinking, mirroring the provider registry's providerOptions() for the legacy engine.
        // display:'summarized' is required for reasoning to be visible: on Claude 4.6+
        // models the raw chain of thought is never returned and the display defaults to
        // 'omitted' (empty thinking text) -- without this the thinking blocks arrive with
        // only a signature and no text, so the reasoning bridge (graph.ts) has nothing to
        // show. 'summarized' returns a readable summary the bridge renders as "Thought for Ns".
        ...(modelId.startsWith('claude-haiku')
          ? {}
          : { thinking: { type: 'adaptive', display: 'summarized' } })
      })
    case 'openai':
      return new ChatOpenAI({ apiKey: requireKey('openai'), model: modelId })
    case 'google':
      return new ChatGoogleGenerativeAI({
        apiKey: requireKey('google'),
        model: modelId,
        // Gemini 2.5+ / 3.x models support thought summaries via thinkingConfig
        // (`GoogleGenerativeAIThinkingConfig` in @langchain/google-genai's types.d.ts).
        // Older 1.x models don't support thinking and error if this is set, so guard
        // on model id, mirroring the Haiku exclusion above and the legacy engine's
        // providerOptions() in src/main/ursa/providers/registry.ts.
        ...(/^gemini-1[.-]/.test(modelId) ? {} : { thinkingConfig: { includeThoughts: true } })
      })
    case 'openrouter':
      return new ChatOpenAI({
        apiKey: requireKey('openrouter'),
        model: modelId,
        configuration: { baseURL: 'https://openrouter.ai/api/v1' }
      })
    case 'ollama':
      return new ChatOllama({ baseUrl: getSettings().ollamaBaseUrl, model: modelId })
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}
