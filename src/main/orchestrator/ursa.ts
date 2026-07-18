// Ursa Phase 1: per-turn dynamic model routing. When a conversation's
// modelRef is URSA_MODEL_REF, resolveUrsaModelRef classifies the turn (via
// the same cheap-model mechanism title.ts already uses) and dispatches to a
// curated role's concrete model -- everything downstream (graph.ts, tool
// calls, subagents, usage.ts) is unaware Ursa exists; it only ever sees the
// resolved "provider/modelId" ref.
//
// Roles are NOT user-configurable. The set below is curated in code, the
// same way title.ts's CHEAP_MODEL is a fixed table -- Ursa is meant to work
// like Cursor's or Perplexity's own orchestrator entries: the end user picks
// "Ursa" and it just routes, with no settings surface for assigning models to
// roles. Settings > Ursa is limited to an on/off toggle and a read-only key
// status check (see UrsaPage.tsx) -- never role editing.
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

// The fixed, curated role table. Deliberately small and cross-provider so
// Ursa demonstrates real routing (not just picking within one provider's
// tiers) -- adjust this table in code as better-suited models arrive; it is
// never surfaced for editing in the app.
export const CURATED_ROLES: readonly UrsaRole[] = [
  {
    name: 'architect',
    modelRef: 'anthropic/claude-opus-4-8',
    description: 'Complex, high-stakes design and architecture decisions'
  },
  {
    name: 'coder',
    modelRef: 'openai/gpt-5.6-sol',
    description: 'Writing and refactoring code, debugging'
  },
  {
    name: 'reviewer',
    modelRef: 'anthropic/claude-sonnet-5',
    description: 'General-purpose review, explanation, everyday tasks'
  },
  {
    name: 'grunt',
    modelRef: 'anthropic/claude-haiku-4-5',
    description: 'Simple, mundane, low-stakes requests'
  }
]

const ClassifierOutput = z.object({
  role: z.string().describe('The name of the role best suited to handle this message')
})

// A role is eligible only if its provider currently has a configured key
// (mirrors ModelPicker.tsx's provider.reachable / requiresKey && !keyConfigured
// dimming logic) -- Ursa must never select a role it cannot actually run.
function eligibleRoles(roles: readonly UrsaRole[]): UrsaRole[] {
  const status = keyStatus()
  return roles.filter((r) => {
    const { provider } = parseModelRef(r.modelRef)
    return provider === 'ollama' || status[provider]
  })
}

// The set of providers Ursa's curated roles depend on -- read by the
// Settings > Ursa page to render its read-only key-status check.
export function ursaRequiredProviders(): ProviderId[] {
  const seen = new Set<ProviderId>()
  for (const r of CURATED_ROLES) seen.add(parseModelRef(r.modelRef).provider)
  return [...seen]
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
}): Promise<{ modelRef: string; roleName: string }> {
  if (!getSettings().ursaEnabled) {
    throw new Error('Ursa is disabled. Enable it in Settings > Ursa.')
  }

  const roles = eligibleRoles(CURATED_ROLES)
  if (roles.length === 0) {
    throw new Error(
      'None of the providers Ursa uses have an API key configured. Add one in Settings > Providers.'
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
    // whole turn.
    chosenName = roles[0].name
  }

  const chosen = roles.find((r) => r.name === chosenName) ?? roles[0]
  return { modelRef: chosen.modelRef, roleName: chosen.name }
}
