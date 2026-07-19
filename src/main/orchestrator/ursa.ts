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
    name: 'verifier',
    modelRef: 'perplexity/sonar-pro',
    description:
      'Fact-checking and verification against the live web: confirming claims, looking up ' +
      'current events, prices, versions, release dates, or anything whose answer depends on ' +
      'up-to-date external information, with sources. NOT for writing code, building things, ' +
      "or reviewing the user's own files -- only for checking facts out in the world."
  },
  {
    name: 'grunt',
    modelRef: 'openai/gpt-5.6-luna',
    description:
      'Trivial, low-stakes requests: greetings, one-liners, quick lookups, tiny text edits.'
  }
]

// Subagent-level routing (Ursa Arc 2, Task 1): applies ONLY while a turn runs
// under Ursa (ursaRole set) -- see graph.ts buildAgentAndContext. Fixed,
// code-curated, NOT user-configurable, same philosophy as CURATED_ROLES above.
// Keys are deepagents subagent names from graph.ts's SUBAGENT_NAMES; values
// are CURATED_ROLES role names. 'general-purpose' (deepagents' own built-in
// subagent) is deliberately absent -- createDeepAgent gives it no model hook
// to override in this version (see graph.ts:173-193), so it always inherits
// the turn's main model regardless of this map.
export const SUBAGENT_ROLE_MAP: Readonly<Record<string, string>> = {
  researcher: 'reviewer', // read-heavy synthesis rides the mid-tier Sonnet
  browser: 'grunt' // mechanical DOM driving rides the cheap fast model
}

// For each SUBAGENT_ROLE_MAP entry, resolve the mapped role to its concrete
// modelRef -- but only when that role's provider currently has a configured
// key (reuses eligibleRoles' keyStatus/parseModelRef check, so a subagent
// never gets routed to a role BearCode can't actually run; it silently
// falls back to inheriting the turn's main model instead, same as when
// ursaRole is unset). Returns a partial map -- possibly empty.
export function resolveSubagentModelRefs(): Record<string, string> {
  const eligible = eligibleRoles(CURATED_ROLES)
  const result: Record<string, string> = {}
  for (const [subagentName, roleName] of Object.entries(SUBAGENT_ROLE_MAP)) {
    const role = eligible.find((r) => r.name === roleName)
    if (role) result[subagentName] = role.modelRef
  }
  return result
}

const ClassifierOutput = z.object({
  role: z.string().describe('The name of the role best suited to handle this message'),
  // Ursa Phase 2: an OPTIONAL multi-step pipeline. Only for genuinely
  // multi-part requests with an explicit ordering; validated in code against
  // the eligible role set (see resolvePipelineSteps) and consent-gated before
  // any step runs. Omitted for the common single-deliverable case, so a normal
  // turn is byte-identical to Phase 1.
  pipeline: z
    .array(z.object({ role: z.string(), subtask: z.string().max(200) }))
    .min(2)
    .max(4)
    .optional()
    .describe(
      'ONLY for genuinely multi-part requests with an explicit ordering: 2-4 sequential steps. Omit for a single deliverable.'
    )
})

// Validate a classifier-proposed pipeline against the ELIGIBLE role set and
// resolve each step to its curated concrete modelRef. Every step.role must be
// an eligible role -- otherwise the WHOLE pipeline is discarded (returns
// undefined) and the turn silently falls back to the single-role path (the
// classifier's `role` field). Roles stay curated: the classifier can only name
// roles it was shown, never invent one -- the same guarantee `chosenName`
// already gives for the single-role choice. The 2-4 length is enforced by the
// schema but re-checked here so a malformed payload degrades rather than throws.
export function resolvePipelineSteps(
  proposed: Array<{ role: string; subtask: string }> | undefined,
  roles: readonly UrsaRole[]
): Array<{ role: string; modelRef: string; subtask: string }> | undefined {
  if (!proposed || proposed.length < 2 || proposed.length > 4) return undefined
  const resolved: Array<{ role: string; modelRef: string; subtask: string }> = []
  for (const step of proposed) {
    const role = roles.find((r) => r.name === step.role)
    if (!role) return undefined // ineligible/unknown role -> discard entire pipeline
    resolved.push({ role: role.name, modelRef: role.modelRef, subtask: step.subtask })
  }
  return resolved
}

// Reverse-lookup a resolved concrete modelRef back to its curated role name.
// Used by the DECLINED-pipeline path (Phase 2 Task 3): when the user declines a
// proposal, the turn runs single-role on the classifier's fallback modelRef --
// which is persisted (last_resolved_model_ref) -- but its role NAME is not, so
// the declined turn recovers the role for turn_meta from the curated table.
// undefined when no curated role maps to that ref (e.g. the table's modelRefs
// changed across an app update between proposal and decline) -- an honest
// degradation to a role-less turn_meta, never a wrong role.
export function roleNameForModelRef(modelRef: string): string | undefined {
  return CURATED_ROLES.find((r) => r.modelRef === modelRef)?.name
}

// Ursa Modes (Task 3): the 'code' mode hard-locks to the coder role, skipping
// the classifier entirely. Returns undefined when the coder role's provider
// has no configured key, so the caller can fall through to the normal auto
// (classifier) path instead of ever handing back a role the turn can't run --
// same eligibility check eligibleRoles() applies to the whole curated set.
export function coderRoleIfEligible(): UrsaRole | undefined {
  const role = CURATED_ROLES.find((r) => r.name === 'coder')
  if (!role) return undefined
  const { provider } = parseModelRef(role.modelRef)
  const status = keyStatus()
  return provider === 'ollama' || status[provider] ? role : undefined
}

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
  // Ursa Phase 2: a consent-gated multi-step pipeline for a genuinely
  // multi-part request. Present ONLY when the classifier proposed one AND every
  // step's role is eligible (see resolvePipelineSteps); undefined for the common
  // single-deliverable turn, and never set on the skip/failure/no-key paths.
  pipeline?: Array<{ role: string; modelRef: string; subtask: string }>
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
  // Ursa Phase 2: filled in only when the classifier proposes a valid pipeline
  // (successful classification path below). Stays undefined on the skip and
  // failure paths, so those turns are byte-identical to Phase 1.
  let pipeline: Array<{ role: string; modelRef: string; subtask: string }> | undefined
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
            'Propose a pipeline (the optional field) ONLY when the message explicitly ' +
            'contains multiple distinct deliverables with an ordering between them ' +
            '("build X, then review it and fix what the review finds", "research A, ' +
            'then implement B using it"). A single deliverable -- however large or ' +
            'complex -- is NEVER a pipeline: it is one role. When you are unsure, do ' +
            'not propose a pipeline; return just the single best role.\n' +
            contextBlock +
            hysteresis +
            `Available roles:\n${roleList}` +
            guidance
        ),
        new HumanMessage(opts.userText.slice(0, 2000))
      ])
      chosenName = result.parsed.role
      // Ursa Phase 2: validate/resolve any proposed pipeline against the eligible
      // role set. An unknown/ineligible step role discards the WHOLE pipeline and
      // the turn falls back to the single-role choice above (silently).
      pipeline = resolvePipelineSteps(result.parsed.pipeline, roles)
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
    ...(classifierUsage ? { classifierUsage } : {}),
    ...(pipeline ? { pipeline } : {})
  }
}
