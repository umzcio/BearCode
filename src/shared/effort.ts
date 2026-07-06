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

// Which composer controls are live for a given model ref ("provider/modelId").
// Effort tiers are Anthropic-only this phase; Thinking is live for
// Anthropic(non-Haiku)/Google(non-1.x)/Ollama. Pure — used by the renderer for
// UI gating and mirrored by the main-side mapping in orchestrator/models.ts.
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
    default:
      // openai, openrouter, unknown: reasoning is folded into effort (greyed) and
      // there is no separate thinking knob.
      return { effortEnabled: false, thinkingEnabled: false }
  }
}
