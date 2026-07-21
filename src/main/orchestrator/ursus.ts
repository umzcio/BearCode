// Ursus: a fully independent sibling router to Ursa (main/orchestrator/ursa.ts),
// restricted entirely to models reachable through OpenRouter and local Ollama --
// no frontier/flagship providers. Same "pick the router, let it route" mechanism
// as Ursa (curated role table + classifier + optional pipeline), but its own
// table, its own classifier call, and no shared state with Ursa's CURATED_ROLES --
// same independence precedent Council already set. v1 is single-mode only: no
// Council/Deep-Research equivalent, no mode concept at all (see
// planning/2026-07-20-ursus-design.md).
//
// Roles are NOT user-configurable -- same philosophy as Ursa. Settings > Ursus is
// limited to an on/off toggle and a read-only provider status check (see
// UrsusPage.tsx), never role editing.
import { z } from 'zod'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { ProviderId, UrsaRole } from '../../shared/types'
import { URSUS_MODEL_REF } from '../../shared/types'
import { makeModel } from './models'
import { getSettings } from '../settings'
import { keyStatus } from '../keys'
import { parseModelRef, listOllamaModels } from '../providers/registry'
import { resolvePipelineSteps } from './ursa'

// Re-exported (not redeclared) so main-process callers of ursus.ts and renderer
// callers of shared/types.ts see the exact same sentinel string.
export { URSUS_MODEL_REF }

export function isUrsusModelRef(ref: string): boolean {
  return ref === URSUS_MODEL_REF
}

// The fixed, curated role table -- restricted entirely to OpenRouter/Ollama.
// Every model ref was verified live (tool-calling + availability) during this
// feature's design; see planning/2026-07-20-ursus-design.md for sourcing.
// Descriptions carry strengths/cost-tier framing INLINE (unlike Ursa's, which
// pulls that from registry.ts's capabilitiesFor table) -- that table returns
// null for every openrouter/ollama ref today, so Ursus's classifier prompt
// would otherwise get materially less signal than Ursa's.
export const CURATED_URSUS_ROLES: readonly UrsaRole[] = [
  {
    name: 'architect',
    modelRef: 'ollama/ornith:35b',
    description:
      'Planning and design discussions where the deliverable is a decision or a plan, ' +
      'not files: weighing approaches, system architecture, "help me plan/think through X". ' +
      'NOT for requests to actually build or write something -- that is coder work. ' +
      '(model strengths: agentic planning and self-scaffolding; runs entirely locally)'
  },
  {
    name: 'coder',
    modelRef: 'openrouter/moonshotai/kimi-k3',
    description:
      'Any request whose deliverable is code or files: build a website/app/script, ' +
      'implement a feature, write/refactor/debug code. From one-line fixes to entire ' +
      'projects -- size and complexity do not matter, only that the user wants ' +
      'something built rather than planned or explained. ' +
      '(model strengths: agentic coding; cost tier: low)'
  },
  {
    name: 'reviewer',
    modelRef: 'openrouter/z-ai/glm-5.2',
    description:
      'Explaining or reviewing existing code or content, answering substantive ' +
      'questions, and everyday conversational tasks that produce no files. ' +
      '(model strengths: consistency and debugging; cost tier: low)'
  },
  {
    name: 'verifier',
    modelRef: 'openrouter/deepseek/deepseek-v4-pro',
    description:
      'Fact-checking and verification against the live web: confirming claims, ' +
      'looking up current events, prices, versions, release dates, or anything ' +
      "whose answer depends on up-to-date external information, with sources. " +
      "NOT for writing code, building things, or reviewing the user's own files " +
      '-- only for checking facts out in the world. (model strengths: reasoning, ' +
      'verification, live web search; cost tier: mid)'
  },
  {
    name: 'grunt',
    modelRef: 'openrouter/minimax/minimax-m3',
    description:
      'Trivial, low-stakes requests: greetings, one-liners, quick lookups, tiny text edits. ' +
      '(model strengths: fast, cheap, general; cost tier: low)'
  }
]

// Subagent-level routing, same shape/philosophy as Ursa's SUBAGENT_ROLE_MAP.
// Deliberately never maps to 'architect' (the only Ollama-backed role) -- see
// resolveSubagentUrsusModelRefs below for why.
export const SUBAGENT_URSUS_ROLE_MAP: Readonly<Record<string, string>> = {
  researcher: 'reviewer',
  browser: 'grunt'
}

// Unlike eligibleUrsusRoles below, this stays SYNCHRONOUS: its only caller,
// graph.ts's buildSubagents, is itself synchronous (called inline while
// constructing createDeepAgent's options), and making it async would force an
// async ripple through buildAgentAndContext and its caller -- out of scope for
// subagent routing. This is safe ONLY because neither mapped role above is
// Ollama-backed (both ride OpenRouter, which keyStatus() checks synchronously);
// if a future mapping ever points at 'architect', it is honestly excluded here
// (Ollama's live reachability can't be confirmed without the async probe) rather
// than guessing eligibility.
export function resolveSubagentUrsusModelRefs(): Record<string, string> {
  const status = keyStatus()
  const result: Record<string, string> = {}
  for (const [subagentName, roleName] of Object.entries(SUBAGENT_URSUS_ROLE_MAP)) {
    const role = CURATED_URSUS_ROLES.find((r) => r.name === roleName)
    if (!role) continue
    const { provider } = parseModelRef(role.modelRef)
    if (status[provider]) result[subagentName] = role.modelRef
  }
  return result
}

// Mirrors ursa.ts's roleNameForModelRef -- used by the DECLINED-pipeline path
// so a declined Ursus proposal recovers its role name for turn_meta the same
// way a declined Ursa proposal does. undefined when no curated Ursus role
// maps to that ref, an honest degradation to a role-less turn_meta.
export function roleNameForModelRef(modelRef: string): string | undefined {
  return CURATED_URSUS_ROLES.find((r) => r.modelRef === modelRef)?.name
}

// The set of providers Ursus's curated roles depend on -- read by Settings >
// Ursus to render its read-only provider-status check.
export function ursusRequiredProviders(): ProviderId[] {
  const seen = new Set<ProviderId>()
  for (const r of CURATED_URSUS_ROLES) seen.add(parseModelRef(r.modelRef).provider)
  return [...seen]
}

// A role is eligible only if its provider can actually run it right now.
// OpenRouter roles: synchronous keyStatus() check, same as Ursa. The Ollama role
// (architect): a LIVE reachability probe (listOllamaModels, ~2s timeout) AND
// confirmation the specific pulled model matches -- unlike Ursa's "ollama is
// always eligible" shortcut, Ursus actually depends on a specific local model
// being present, so "no key required" is not the same as "usable." ASYNC --
// every caller must await this.
export async function eligibleUrsusRoles(roles: readonly UrsaRole[]): Promise<UrsaRole[]> {
  const status = keyStatus()
  const result: UrsaRole[] = []
  for (const r of roles) {
    const { provider, modelId } = parseModelRef(r.modelRef)
    if (provider === 'ollama') {
      const { models, reachable } = await listOllamaModels()
      if (reachable && models.some((m) => m.id === modelId)) result.push(r)
    } else if (status[provider]) {
      result.push(r)
    }
  }
  return result
}

const ClassifierOutput = z.object({
  role: z.string().describe('The name of the role best suited to handle this message'),
  pipeline: z
    .array(z.object({ role: z.string(), subtask: z.string().max(200) }))
    .min(2)
    .max(4)
    .optional()
    .describe(
      'ONLY for genuinely multi-part requests with an explicit ordering: 2-4 sequential steps. Omit for a single deliverable.'
    )
})

export async function resolveUrsusModelRef(opts: {
  userText: string
  recentContext?: string
  previousRole?: string
}): Promise<{
  modelRef: string
  roleName: string
  classifierUsage?: { modelRef: string; inputTokens: number; outputTokens: number }
  pipeline?: Array<{ role: string; modelRef: string; subtask: string }>
}> {
  if (!getSettings().ursusEnabled) {
    throw new Error('Ursus is disabled. Enable it in Settings > Ursus.')
  }

  const roles = await eligibleUrsusRoles(CURATED_URSUS_ROLES)
  if (roles.length === 0) {
    throw new Error(
      'None of the providers Ursus uses are available. Add an OpenRouter key or run Ollama in Settings > Providers.'
    )
  }

  // The classifier always runs on the grunt role's own model -- neither
  // openrouter nor ollama has a CHEAP_MODEL entry (main/title.ts) the way
  // Ursa's classifierProviderId search relies on, and OpenRouter has no single
  // canonical "cheap" model to add one for. If grunt itself is ineligible, skip
  // classification entirely (degrade to the first eligible role) rather than
  // constructing a classifier on some other, more expensive role's model.
  const grunt = roles.find((r) => r.name === 'grunt')

  const roleList = roles.map((r) => `- ${r.name}: ${r.description}`).join('\n')
  let chosenName: string
  let classifierUsage: { modelRef: string; inputTokens: number; outputTokens: number } | undefined
  let pipeline: Array<{ role: string; modelRef: string; subtask: string }> | undefined
  if (!grunt) {
    chosenName = roles[0].name
  } else {
    try {
      const classifier = makeModel(grunt.modelRef).withStructuredOutput(ClassifierOutput, {
        includeRaw: true
      })
      const contextBlock =
        opts.recentContext && opts.recentContext.trim()
          ? `Recent conversation:\n${opts.recentContext.trim()}\n`
          : ''
      const hysteresis = opts.previousRole
        ? `The previous turn in this conversation was handled by role ` +
          `'${opts.previousRole}'. If the new message continues that same task, ` +
          `prefer the same role; switch only when the deliverable clearly changed.\n`
        : ''
      const rawGuidance = getSettings().ursusInstructions
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
      pipeline = resolvePipelineSteps(result.parsed.pipeline, roles)
      const um = (result.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
        .usage_metadata
      if (um && (um.input_tokens != null || um.output_tokens != null)) {
        classifierUsage = {
          modelRef: grunt.modelRef,
          inputTokens: um.input_tokens ?? 0,
          outputTokens: um.output_tokens ?? 0
        }
      }
    } catch {
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
