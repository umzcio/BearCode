// Ursa Phase 1: per-turn dynamic model routing. When a conversation's
// modelRef is URSA_MODEL_REF, resolveUrsaModelRef classifies the turn (via
// the same cheap-model mechanism title.ts already uses) and dispatches to a
// user-configured role's concrete model -- everything downstream (graph.ts,
// tool calls, subagents, usage.ts) is unaware Ursa exists; it only ever sees
// the resolved "provider/modelId" ref.
import { z } from 'zod'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { ProviderId, UrsaRole } from '../../shared/types'
import { URSA_MODEL_REF } from '../../shared/types'
import { makeModel } from './models'
import { CHEAP_MODEL } from '../title'
import { getSettings } from '../settings'
import { keyStatus } from '../keys'
import { parseModelRef } from '../providers/registry'
import { listConversations, getEvents } from '../db'
import { resolvePrice } from '../../shared/pricing'

// Re-exported (not redeclared) so main-process callers of ursa.ts and
// renderer callers of shared/types.ts see the exact same sentinel string.
export { URSA_MODEL_REF }

export function isUrsaModelRef(ref: string): boolean {
  return ref === URSA_MODEL_REF
}

const ClassifierOutput = z.object({
  role: z.string().describe('The name of the role best suited to handle this message')
})

// A role is eligible only if its provider currently has a configured key
// (mirrors ModelPicker.tsx's provider.reachable / requiresKey && !keyConfigured
// dimming logic) -- Ursa must never select a role it cannot actually run.
function eligibleRoles(roles: UrsaRole[]): UrsaRole[] {
  const status = keyStatus()
  return roles.filter((r) => {
    const { provider } = parseModelRef(r.modelRef)
    return provider === 'ollama' || status[provider]
  })
}

// The classifier itself always runs on a cheap/fast model, same mechanism
// title.ts's maybeGenerateTitle already uses -- never a role's own model.
function classifierProviderId(roles: UrsaRole[]): ProviderId {
  for (const r of roles) {
    const { provider } = parseModelRef(r.modelRef)
    if (CHEAP_MODEL[provider]) return provider
  }
  return 'anthropic'
}

// Guardrail (Phase 1): cumulative USD this project has already spent on turns
// routed to `roleName`. Aggregates the durable turn_meta record across the
// project's conversations, priced with the same synced-then-bundled table the
// cost popover uses (resolvePrice). turn_meta carries its own provider/model,
// so pricing keys off the model that actually ran, not the role's assignment.
function projectSpendForRole(roleName: string, projectPath: string | null): number {
  if (!projectPath) return 0
  const { modelPricing } = getSettings()
  let total = 0
  for (const conv of listConversations()) {
    if (conv.projectPath !== projectPath) continue
    for (const event of getEvents(conv.id)) {
      if (event.type !== 'turn_meta' || event.ursaRole !== roleName || !event.usage) continue
      const price = resolvePrice(`${event.provider}/${event.model}`, modelPricing)
      if (!price) continue
      total +=
        (event.usage.inputTokens / 1_000_000) * price.inputPer1M +
        (event.usage.outputTokens / 1_000_000) * price.outputPer1M
    }
  }
  return total
}

export type UrsaResolution =
  | { modelRef: string; roleName: string }
  | { needsConsent: { roleName: string; modelRef: string; reason: string } }

export async function resolveUrsaModelRef(opts: {
  userText: string
  projectPath: string | null
}): Promise<UrsaResolution> {
  const { ursaRoles } = getSettings()
  const roles = eligibleRoles(ursaRoles)
  if (roles.length === 0) {
    throw new Error(
      'Ursa has no roles configured (or none of their providers have a key set). Add a role in Settings > Ursa.'
    )
  }

  const providerId = classifierProviderId(roles)
  const cheapId = CHEAP_MODEL[providerId]
  const classifier = makeModel(`${providerId}/${cheapId}`).withStructuredOutput(ClassifierOutput)

  const roleList = roles.map((r) => `- ${r.name}: ${r.description}`).join('\n')
  let chosenName: string
  try {
    const result = await classifier.invoke([
      new SystemMessage(
        'You are a routing classifier. Given the user message and a list of ' +
          'named roles with descriptions, choose the single best-fitting role. ' +
          `Available roles:\n${roleList}`
      ),
      new HumanMessage(opts.userText.slice(0, 2000))
    ])
    chosenName = result.role
  } catch {
    // Classifier call failed (rate limit, network, malformed output after
    // retries) -- degrade to the first eligible role rather than failing the
    // whole turn. Single-role setups are unaffected either way.
    chosenName = roles[0].name
  }

  const chosen = roles.find((r) => r.name === chosenName) ?? roles[0]

  // Guardrail: if this project's cumulative spend on the chosen role has
  // reached its configured ceiling, surface a typed needsConsent signal rather
  // than resolving silently. The caller (graph.ts) turns this into an
  // actionable refusal -- never a silent overspend, never a permanent block
  // (raising the ceiling or picking a different role clears it immediately).
  const ceiling = getSettings().ursaGuardrails.roleCeilings[chosen.name]
  if (ceiling != null) {
    const spend = projectSpendForRole(chosen.name, opts.projectPath)
    if (spend >= ceiling) {
      return {
        needsConsent: {
          roleName: chosen.name,
          modelRef: chosen.modelRef,
          reason: `"${chosen.name}" has crossed its $${ceiling.toFixed(2)} budget for this project (current: $${spend.toFixed(2)}).`
        }
      }
    }
  }

  return { modelRef: chosen.modelRef, roleName: chosen.name }
}
