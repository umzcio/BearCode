// Hand-authored editorial content (one-line descriptions + tags) for
// BearCode's curated built-in model list -- NOT sourced from LiteLLM or any
// API, unlike ModelMetadata. This is an ongoing content-maintenance cost: add
// an entry here whenever a curated model is added to
// src/main/providers/registry.ts. A ref with no entry (custom models, Ollama,
// OpenRouter models outside this table) renders with no description/tags --
// never a placeholder string.
export interface CatalogInfo {
  description: string
  tags?: string[]
}

export const MODEL_CATALOG: Record<string, CatalogInfo> = {
  'anthropic/claude-fable-5': {
    description:
      "Anthropic's fastest frontier model, tuned for expressive, low-latency conversation.",
    tags: ['Fast']
  },
  'anthropic/claude-opus-4-8': {
    description:
      "Anthropic's most capable model, best for deep reasoning and complex multi-step work.",
    tags: ['Recommended']
  },
  'anthropic/claude-sonnet-5': {
    description: "A balanced default: strong at coding and writing at a fraction of Opus's cost.",
    tags: ['Default']
  },
  'anthropic/claude-haiku-4-5': {
    description: "Anthropic's smallest, cheapest model -- built for quick, high-volume tasks.",
    tags: ['Fast']
  },
  'openai/gpt-5.6-sol': {
    description: "OpenAI's top reasoning-effort model, best for hard coding and analysis tasks.",
    tags: ['Reasoning']
  },
  'openai/gpt-5.6-terra': {
    description: 'A mid-effort GPT-5.6 variant tuned for general writing and everyday tasks.'
  },
  'openai/gpt-5.6-luna': {
    description: "OpenAI's lightweight GPT-5.6 variant for fast, low-cost coding help.",
    tags: ['Fast']
  },
  'google/gemini-3.1-pro-preview': {
    description: "Google's latest Gemini preview, strong at long-context research tasks.",
    tags: ['Recommended']
  },
  'google/gemini-2.5-pro': {
    description: "Google's general-purpose Gemini model with a very large context window."
  },
  'google/gemini-2.5-flash': {
    description: 'A fast, low-cost Gemini model for everyday tasks.',
    tags: ['Fast']
  },
  'openrouter/deepseek/deepseek-chat': {
    description: "DeepSeek's general chat model, routed through OpenRouter."
  },
  'openrouter/moonshotai/kimi-k3': {
    description: "Moonshot AI's Kimi K3, a long-context model routed through OpenRouter."
  },
  'openrouter/z-ai/glm-5.2': {
    description: "Zhipu AI's GLM 5.2, a general-purpose model routed through OpenRouter."
  },
  'openrouter/deepseek/deepseek-v4-pro': {
    description: "DeepSeek's flagship V4 Pro model, routed through OpenRouter."
  },
  'openrouter/minimax/minimax-m3': {
    description: "MiniMax's M3 model, routed through OpenRouter."
  },
  'perplexity/sonar': {
    description: "Perplexity's web-grounded chat model -- every answer cites live sources."
  },
  'perplexity/sonar-pro': {
    description: "A stronger, longer-context version of Perplexity's web-grounded Sonar.",
    tags: ['Recommended']
  },
  'perplexity/sonar-reasoning-pro': {
    description: 'Sonar Pro with an added reasoning pass before answering.',
    tags: ['Reasoning']
  },
  'xai/grok-4.5': {
    description: "xAI's general-purpose Grok model with real function calling."
  },
  'xai/grok-4.20-multi-agent': {
    description:
      "xAI's research mode: parallel server-side agents that search and cross-reference with citations.",
    tags: ['Research']
  },
  'xai/grok-4.3': {
    description: 'A long-context Grok model for general-purpose tasks.'
  },
  'xai/grok-4-fast': {
    description: "xAI's fastest, lowest-cost Grok model.",
    tags: ['Fast']
  }
}

export function catalogInfoFor(ref: string): CatalogInfo | null {
  return MODEL_CATALOG[ref] ?? null
}
