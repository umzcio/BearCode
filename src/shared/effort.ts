import type { EffortLevel } from './types'

// Canonical ordered list of effort states (adaptive default first, then the
// five tiers). The IPC guard and the EffortPicker both derive from this so the
// union can never drift.
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'adaptive',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

// Composer pill + menu labels. 'xhigh' shows as "Extra" (backlog copy).
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  adaptive: 'Adaptive',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max'
}

// Runtime guard for values arriving over IPC. Only rejects garbage.
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

// Mirrors @langchain/openai's own isReasoningModel() heuristic (a prefix
// match, not a version allowlist) -- the same check that gates whether
// buildModelExtras (orchestrator/models.ts) actually sends a reasoning.effort
// value for this model. Keeping the two in sync is what this comment is for:
// if this ever drifts from the real isReasoningModel, the UI would offer an
// effort control that silently does nothing (or vice versa).
function isOpenAIReasoningModel(modelId: string): boolean {
  return /^o\d/.test(modelId) || (modelId.startsWith('gpt-5') && !modelId.startsWith('gpt-5-chat'))
}

// Which composer controls are live for a given model ref ("provider/modelId").
// Effort tiers: Anthropic (non-Haiku) and OpenAI reasoning models (gpt-5*/o*)
// -- both actually forward the chosen effort to the provider (see
// buildModelExtras in orchestrator/models.ts). Thinking is live for
// Anthropic(non-Haiku)/Google(non-1.x)/Ollama. Pure — used by the renderer
// for UI gating and mirrored by the main-side mapping in orchestrator/models.ts.
export function effortCapabilities(
  modelRef: string | null
): { effortEnabled: boolean; thinkingEnabled: boolean } {
  if (!modelRef) return { effortEnabled: false, thinkingEnabled: false }
  const slash = modelRef.indexOf('/')
  const provider = slash === -1 ? modelRef : modelRef.slice(0, slash)
  const modelId = slash === -1 ? '' : modelRef.slice(slash + 1)
  switch (provider) {
    case 'anthropic': {
      const haiku = modelId.startsWith('claude-haiku')
      return { effortEnabled: !haiku, thinkingEnabled: !haiku }
    }
    case 'google':
      return { effortEnabled: false, thinkingEnabled: !/^gemini-1[.-]/.test(modelId) }
    case 'ollama':
      return { effortEnabled: false, thinkingEnabled: true }
    case 'openai':
      // Reasoning is folded into effort (no separate thinking knob) -- only
      // live for models that are actually reasoning models; a non-reasoning
      // OpenAI model has nothing for effort to control.
      return { effortEnabled: isOpenAIReasoningModel(modelId), thinkingEnabled: false }
    default:
      // openrouter, unknown: arbitrary third-party models, no guaranteed
      // reasoning.effort support on the other end -- stays off.
      return { effortEnabled: false, thinkingEnabled: false }
  }
}
