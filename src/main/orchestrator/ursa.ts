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

export async function resolveUrsaModelRef(opts: {
  userText: string
  projectPath: string | null
}): Promise<{ modelRef: string; roleName: string }> {
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
  return { modelRef: chosen.modelRef, roleName: chosen.name }
}
