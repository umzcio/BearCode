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
import { parseModelRef, capabilitiesFor } from '../providers/registry'

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
// Descriptions are the classifier's ONLY signal, so they must be mutually
// exclusive and deliverable-oriented, with explicit "not for" boundaries.
// Lesson from live routing: the original architect description said "design
// and architecture decisions", and a cheap classifier pattern-matched every
// "build/create a website" request onto the word "design" -- two real builds
// in a row went to architect while coder never fired. The discriminator that
// works is the PRIMARY DELIVERABLE: files/code -> coder, a plan/decision ->
// architect, an explanation/answer -> reviewer, a triviality -> grunt.
export const CURATED_ROLES: readonly UrsaRole[] = [
  {
    name: 'architect',
    modelRef: 'anthropic/claude-opus-4-8',
    description:
      'Planning and design discussions where the deliverable is a decision or a plan, ' +
      'not files: weighing approaches, system architecture, "help me plan/think through X". ' +
      'NOT for requests to actually build or write something -- that is coder work.'
  },
  {
    name: 'coder',
    modelRef: 'openai/gpt-5.6-sol',
    description:
      'Any request whose deliverable is code or files: build a website/app/script, ' +
      'implement a feature, write/refactor/debug code. From one-line fixes to entire ' +
      'projects -- size and complexity do not matter, only that the user wants ' +
      'something built rather than planned or explained.'
  },
  {
    name: 'reviewer',
    modelRef: 'anthropic/claude-sonnet-5',
    description:
      'Explaining or reviewing existing code or content, answering substantive ' +
      'questions, and everyday conversational tasks that produce no files.'
  },
  {
    name: 'grunt',
    modelRef: 'openai/gpt-5.6-luna',
    description:
      'Trivial, low-stakes requests: greetings, one-liners, quick lookups, tiny text edits.'
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
// Only returns a provider that has BOTH a CHEAP_MODEL entry AND a configured
// key; returns null when no eligible role's provider qualifies, so callers
// can degrade gracefully instead of constructing a model that will throw.
function classifierProviderId(roles: UrsaRole[]): ProviderId | null {
  const status = keyStatus()
  for (const r of roles) {
    const { provider } = parseModelRef(r.modelRef)
    if (CHEAP_MODEL[provider] && status[provider]) return provider
  }
  return null
}

export async function resolveUrsaModelRef(opts: {
  userText: string
  // Task 4 (#2): a plain transcript of the conversation's recent PRIOR turns,
  // so mid-conversation messages ("now fix that bug") route by the ongoing
  // task, not just the isolated current message. Advisory context, not a rule.
  recentContext?: string
  // Task 4 (#2): the role that handled the previous turn, for hysteresis --
  // biases the classifier to stay on the same role while the task continues.
  // Advisory (prompt-only); never forces the choice in code.
  previousRole?: string
}): Promise<{
  modelRef: string
  roleName: string
  // Task 5 (#3): the classifier call's OWN token usage, on the cheap model it
  // ran on -- so its (real) cost is accounted for on turn_meta rather than
  // vanishing. undefined when classification was skipped (no eligible cheap
  // provider) or the classifier call failed/reported no usage.
  classifierUsage?: { modelRef: string; inputTokens: number; outputTokens: number }
}> {
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

  const roleList = roles
    .map((r) => {
      const caps = capabilitiesFor(r.modelRef)
      const suffix = caps
        ? ` (model strengths: ${caps.strengths.join(', ')}; cost tier: ${caps.costTier})`
        : ''
      return `- ${r.name}: ${r.description}${suffix}`
    })
    .join('\n')
  let chosenName: string
  let classifierUsage: { modelRef: string; inputTokens: number; outputTokens: number } | undefined
  if (providerId === null) {
    // No eligible role's provider has both a CHEAP_MODEL entry and a
    // configured key -- skip classification entirely rather than risk
    // makeModel throwing outside this try/catch, and degrade to the first
    // eligible role.
    chosenName = roles[0].name
  } else {
    try {
      const cheapId = CHEAP_MODEL[providerId]
      // includeRaw:true so we also get the underlying AIMessage and can read
      // its usage_metadata (Task 5) -- withStructuredOutput otherwise hands
      // back only the parsed object, discarding the token counts.
      const classifier = makeModel(`${providerId}/${cheapId}`).withStructuredOutput(
        ClassifierOutput,
        { includeRaw: true }
      )
      // Advisory prompt additions (Task 4): a recent-conversation block before
      // the role list, and a previous-role hysteresis line -- both bias the
      // choice without being hard rules (the chosen name still validates
      // against the curated set below).
      const contextBlock =
        opts.recentContext && opts.recentContext.trim()
          ? `Recent conversation:\n${opts.recentContext.trim()}\n`
          : ''
      const hysteresis = opts.previousRole
        ? `The previous turn in this conversation was handled by role ` +
          `'${opts.previousRole}'. If the new message continues that same task, ` +
          `prefer the same role; switch only when the deliverable clearly changed.\n`
        : ''
      // Task 7 (#8): the user's optional custom instructions -- advisory guidance
      // that biases routing but can NEVER invent a role (the chosen name still
      // validates against the curated set below). Appended AFTER the role list so
      // it reads as a bias over the definitions, not a replacement for them.
      const rawGuidance = getSettings().ursaInstructions
      const guidance =
        typeof rawGuidance === 'string' && rawGuidance.trim()
          ? `\nUser guidance (advisory, never overrides role definitions):\n${rawGuidance.trim()}`
          : ''
      const result = await classifier.invoke([
        new SystemMessage(
          'You are a routing classifier. Given the user message and a list of ' +
            'named roles with descriptions, choose the single best-fitting role.\n' +
            'Classify by the PRIMARY DELIVERABLE of the message, not its difficulty: ' +
            'a request to build or create something concrete is coder work no matter ' +
            'how large or complex; pick architect only when the user is explicitly ' +
            'asking to plan, decide, or design BEFORE building.\n' +
            contextBlock +
            hysteresis +
            `Available roles:\n${roleList}` +
            guidance
        ),
        new HumanMessage(opts.userText.slice(0, 2000))
      ])
      chosenName = result.parsed.role
      // Same usage_metadata fields usage.ts reads for the main turn. Absent on
      // providers that report nothing -- then classifierUsage stays undefined.
      const um = (result.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
        .usage_metadata
      if (um && (um.input_tokens != null || um.output_tokens != null)) {
        classifierUsage = {
          modelRef: `${providerId}/${cheapId}`,
          inputTokens: um.input_tokens ?? 0,
          outputTokens: um.output_tokens ?? 0
        }
      }
    } catch {
      // Classifier call failed (rate limit, network, malformed output after
      // retries, or makeModel itself throwing) -- degrade to the first
      // eligible role rather than failing the whole turn.
      chosenName = roles[0].name
    }
  }

  const chosen = roles.find((r) => r.name === chosenName) ?? roles[0]
  return {
    modelRef: chosen.modelRef,
    roleName: chosen.name,
    ...(classifierUsage ? { classifierUsage } : {})
  }
}
