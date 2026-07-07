// Auto-compaction tuning (Task C3): configure the deepagents summarization
// middleware so it fires at ~85% of the model's REAL context window, keeps
// roughly the recent half verbatim, and writes summaries with a cheap fast
// model (falling back to the conversation model when no cheap sibling exists).
//
// deepagents' `createDeepAgent()` already assembles a default
// `SummarizationMiddleware` at a generic threshold. We surface a REPLACEMENT
// tuned to each model: `excludeDefaultSummarization()` removes the default from
// the main agent's stack (via the harness-profile registry, keyed by the model
// class' provider), and `buildTunedSummarization()` builds our configured
// middleware — renamed so it survives that same name-based exclusion filter.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createSummarizationMiddleware, registerHarnessProfile, StateBackend } from 'deepagents'
import type { AnyBackendProtocol, BackendFactory } from 'deepagents'
import { CHEAP_MODEL } from '../title'
import { contextWindowFor, parseModelRef } from '../providers/registry'
import { makeModel } from './models'

// deepagents hardcodes this `.name` on its default summarization middleware
// (verified: dist/langsmith-*.js). The harness-profile exclusion filter matches
// on `.name`, so our replacement must NOT reuse it or it would be filtered too.
const DEFAULT_SUMMARY_MW_NAME = 'SummarizationMiddleware'
const TUNED_SUMMARY_MW_NAME = 'BearcodeSummarizationMiddleware'

// Summaries preserve the load-bearing context and drop the rest.
const SUMMARY_PROMPT =
  'Summarize the conversation so far, preserving decisions, facts, file paths, ' +
  'and open tasks; omit chit-chat.'

// Trigger at 85% of the real window so compaction is a safety net that fires
// before the provider's hard context-length error. `null` when the window is
// unknown (Ollama/OpenRouter) — the middleware then keeps its own default.
export function summaryTriggerTokens(modelRef: string): number | null {
  const window = contextWindowFor(modelRef)
  if (window == null) return null
  return Math.floor(0.85 * window)
}

// The cheap fast sibling to summarize with, as a "provider/modelId" ref.
// Providers with no curated cheap model (Ollama/OpenRouter) reuse the
// conversation's own model. Pure — mirrors title.ts.
export function cheapModelRef(modelRef: string): string {
  const { provider, modelId } = parseModelRef(modelRef)
  const cheapId = CHEAP_MODEL[provider] ?? modelId
  return `${provider}/${cheapId}`
}

// Instantiate the cheap summary model, or `undefined` when it can't be built
// (e.g. missing API key). On `undefined` the middleware falls back to the
// active conversation model, so summarization still works.
export function buildCheapSummaryModel(modelRef: string): BaseChatModel | undefined {
  try {
    return makeModel(cheapModelRef(modelRef), {})
  } catch (err) {
    console.log(
      '[bearcode] cheap summary model unavailable, using conversation model:',
      err instanceof Error ? err.message : err
    )
    return undefined
  }
}

// Whether this provider's default summarization gets excluded by
// `excludeDefaultSummarization()`. Ollama's model class resolves to no harness
// profile, so its default is never excluded — we must leave it in place (and it
// has no known window to tune against anyway).
export function tunesSummarization(modelRef: string): boolean {
  return parseModelRef(modelRef).provider !== 'ollama'
}

let excluded = false

// Remove deepagents' default summarization middleware from the MAIN agent's
// stack for the providers we tune. Registers provider-level harness profiles in
// the process-global registry; idempotent (registration merges, and the guard
// makes it a one-time call). Subagents build their own stacks and are
// unaffected, so the researcher subagent keeps its default summarization.
export function excludeDefaultSummarization(): void {
  if (excluded) return
  excluded = true
  // ChatAnthropic→"anthropic", ChatOpenAI→"openai" (also OpenRouter),
  // ChatGoogleGenerativeAI→"google". ChatOllama→no provider→not excluded.
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    registerHarnessProfile(provider, { excludedMiddleware: [DEFAULT_SUMMARY_MW_NAME] })
  }
}

// Build the tuned summarization middleware for a turn: 85%-window token
// trigger (when known), keep the recent half, cheap summary model (when
// available), concise summary prompt. Renamed so the default-exclusion filter
// (which matches DEFAULT_SUMMARY_MW_NAME) leaves it in place.
export function buildTunedSummarization(
  modelRef: string,
  backend: AnyBackendProtocol | BackendFactory
): ReturnType<typeof createSummarizationMiddleware> {
  const window = contextWindowFor(modelRef)
  const trigger = summaryTriggerTokens(modelRef)
  const model = buildCheapSummaryModel(modelRef)
  const mw = createSummarizationMiddleware({
    backend,
    ...(model ? { model } : {}),
    ...(trigger != null ? { trigger: { type: 'tokens', value: trigger } } : {}),
    // Keep the recent half of the CONVERSATION window verbatim, expressed in
    // absolute tokens rather than a fraction: the middleware resolves a
    // fraction against the SUMMARY model's window, so a small/cheap summarizer
    // (or one lacking a token profile) would keep far too little — down to
    // ~nothing. 0.5 * the conversation window matches the "keep recent half"
    // intent; fall back to the fraction only when the window is unknown.
    keep:
      window != null
        ? { type: 'tokens', value: Math.floor(window * 0.5) }
        : { type: 'fraction', value: 0.5 },
    summaryPrompt: SUMMARY_PROMPT
  })
  mw.name = TUNED_SUMMARY_MW_NAME
  return mw
}

// The default StateBackend factory deepagents uses when no filesystem backend
// is supplied — mirrored so the summarization middleware persists offloaded
// history exactly as the default stack would.
export function defaultStateBackendFactory(): BackendFactory {
  return (runtime) => new StateBackend(runtime)
}
