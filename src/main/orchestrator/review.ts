// Reviewer mode: a deliberate multi-model panel AUDIT of a target through a
// chosen lens, producing structured findings (not prose). Mirrors council.ts's
// panel shape (seats + chair) but is findings-oriented. Rosters are
// code-curated, own table per mode (separate from the councils so they can be
// tuned independently). See planning/2026-07-21-reviewer-mode-design.md.
import { z } from 'zod'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { ReviewLens } from '../../shared/types'
import type { CouncilConfig } from './council'
import { makeModel } from './models'
import { keyStatus } from '../keys'
import { parseModelRef } from '../providers/registry'
import { CHEAP_MODEL } from '../title'

export const URSA_REVIEW_PANEL: CouncilConfig = {
  seats: ['anthropic/claude-fable-5', 'openai/gpt-5.6-sol', 'xai/grok-4.5'],
  chair: 'anthropic/claude-sonnet-5',
  unavailable:
    'Review needs an Anthropic API key (Sonnet 5 chairs the panel) plus at least one ' +
    'of OpenAI or xAI for the reviewer seats. Add the missing key(s) in Settings > Providers.'
}

const LENSES: readonly ReviewLens[] = [
  'code', 'security', 'accessibility', 'performance', 'comprehensive'
]

const CODE_RUBRIC =
  'CODE QUALITY: correctness bugs, unhandled edge cases, race conditions, resource leaks, ' +
  'dead code, duplicated logic, unclear naming, and missing test coverage for changed behavior.'
const SECURITY_RUBRIC =
  'SECURITY: injection (SQL/command/path), unsafe deserialization, secrets committed in code, ' +
  'missing authz/authn checks, unvalidated input crossing a trust boundary, and risky dependencies.'
const A11Y_RUBRIC =
  'ACCESSIBILITY: missing semantic HTML, keyboard traps or unreachable controls, missing focus ' +
  'management and visible focus, insufficient contrast, missing ARIA/labels, and animations with ' +
  'no prefers-reduced-motion fallback.'
const PERF_RUBRIC =
  'PERFORMANCE: hot-path allocations, N+1 queries or requests, layout thrash and forced reflow, ' +
  'unnecessary re-renders, oversized bundles, and unbounded memory growth.'

const RUBRICS: Record<Exclude<ReviewLens, 'comprehensive'>, string> = {
  code: CODE_RUBRIC,
  security: SECURITY_RUBRIC,
  accessibility: A11Y_RUBRIC,
  performance: PERF_RUBRIC
}

// The lens is the ONLY thing that changes between review types; comprehensive
// concatenates all four checklists into one pass, findings tagged per lens.
export function rubricFor(lens: ReviewLens): string {
  if (lens === 'comprehensive') return Object.values(RUBRICS).join('\n')
  return RUBRICS[lens]
}

// Lightweight lens/scope classifier: reads the user's message, returns whatever
// it can pin down; leaves a field undefined when the user did not clearly say
// (the caller then asks). Runs on a cheap model, same mechanism the Ursa
// classifier uses. Out-of-set lens values are dropped, never trusted.
const RequestSchema = z.object({
  lens: z.string().optional().describe(
    "One of: code, security, accessibility, performance, comprehensive -- ONLY if the user " +
    "clearly indicated which. Omit if they just said 'review this' with no type."
  ),
  scope: z.string().optional().describe(
    "What to review (a path, 'the diff', or 'what was just built') -- ONLY if clearly stated. Omit otherwise."
  )
})

// Prefers a dedicated cheap model on any keyed first-party provider; if none
// is keyed (an all-OpenRouter Ursus setup has no CHEAP_MODEL entry by design),
// falls back to reusing a panel model already in play -- classifying on a
// keyed OpenRouter seat rather than silently refusing to classify at all.
function cheapClassifierRef(panel: CouncilConfig): string | null {
  const status = keyStatus()
  for (const provider of Object.keys(CHEAP_MODEL)) {
    const cheap = CHEAP_MODEL[provider as keyof typeof CHEAP_MODEL]
    if (cheap && status[provider]) return `${provider}/${cheap}`
  }
  for (const ref of [...panel.seats, panel.chair]) {
    if (status[parseModelRef(ref).provider]) return ref
  }
  return null
}

export async function resolveReviewRequest(
  userText: string,
  panel: CouncilConfig
): Promise<{ lens?: ReviewLens; scope?: string }> {
  const ref = cheapClassifierRef(panel)
  if (!ref) return {} // nothing keyed at all -> ask for everything
  const out = (await makeModel(ref)
    .withStructuredOutput(RequestSchema)
    .invoke([
      new SystemMessage(
        'Extract the review LENS and SCOPE from the user message. Only fill a field if the ' +
        'user clearly stated it; otherwise omit it. Do not guess.'
      ),
      new HumanMessage(userText)
    ])) as { lens?: string; scope?: string }
  const lens = LENSES.includes(out.lens as ReviewLens) ? (out.lens as ReviewLens) : undefined
  const scope = typeof out.scope === 'string' && out.scope.trim() ? out.scope.trim() : undefined
  return { lens, scope }
}
