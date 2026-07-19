// Ursa Modes (Task 4): the Council runner. When a conversation's Ursa mode is
// 'council', a turn does NOT go through the single-agent graph -- instead the
// SAME question is put to three curated, cross-provider seats in parallel and
// TOOLLESS (plain model.invoke, no agent, no tools -- three agents mutating one
// workspace at once is chaos by construction, so deliberation is read-only),
// each seat then peer-reviews the others' answers ANONYMOUSLY, and finally the
// Fable 5 chair synthesizes ONE streamed answer marking where the council
// agrees, where it diverges (and why it matters), the unique insights, and its
// confidence. Shape follows Perplexity's Model Council + Karpathy's LLM Council
// (design §Council runner).
//
// Roles/seats/chair are code-curated, NEVER user-configurable -- same
// philosophy as ursa.ts's CURATED_ROLES. This module deliberately imports NO
// tool/agent machinery (buildTools, createDeepAgent, ...): the toollessness is
// structural, not a runtime flag.
import { randomUUID } from 'crypto'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { AIMessageChunk } from '@langchain/core/messages'
import type { Event } from '../../shared/types'
import type { RunSink } from '../sink'
import { makeModel } from './models'
import { textDeltaEvent } from './bridge'
import { appendEvent, getConversationMeta, getRecentUrsaContext } from '../db'
import { keyStatus } from '../keys'
import { maybeGenerateTitle } from '../title'
import { parseModelRef } from '../providers/registry'

// The curated council. Provider diversity is the point (design §Council runner):
// OpenAI's practical/agentic execution, Google's research grounding, and xAI's
// fresher/less-filtered perspective sit as SEATS; Anthropic's Fable 5 chairs
// (deep reasoning + synthesis) and is NOT a seat. Adjust in code only.
export const COUNCIL_SEATS: readonly string[] = [
  'openai/gpt-5.6-sol', // agentic execution + practical tasks
  'google/gemini-3.1-pro-preview', // research grounding + multimodal
  'xai/grok-4.5' // fresh perspectives, real-time, less filtered
]
export const COUNCIL_CHAIR = 'anthropic/claude-fable-5' // deep reasoning + synthesis, NOT a seat

// A completed seat answer carried between stages. `seatRef` is the concrete
// "provider/modelId"; `text` is the seat's full answer.
export interface CouncilSeatAnswer {
  seatRef: string
  text: string
}

// One anonymized answer as a reviewer sees it: a bare "Response A/B/..." label
// and the text. `seatRef` is retained ONLY so the chair can later de-anonymize
// -- it is NEVER rendered into a reviewer's prompt (that is the anonymization
// guarantee; see buildReviewPrompt).
export interface LabeledAnswer {
  label: string
  seatRef: string
  text: string
}

// A completed peer review, with the label->seat mapping needed to de-anonymize
// it for the chair.
export interface ResolvedReview {
  reviewerRef: string
  text: string
  mapping: LabeledAnswer[]
}

// The seats whose provider currently has a configured key. Seats are never
// Ollama, so a plain keyStatus check suffices (mirrors ursa.ts's eligibleRoles).
export function eligibleSeats(): string[] {
  const status = keyStatus()
  return COUNCIL_SEATS.filter((ref) => status[parseModelRef(ref).provider])
}

// A short display label for a seat/chair (the modelId portion of the ref), used
// both in the council_seat event and in the chair prompt's named answers.
export function seatLabel(ref: string): string {
  return parseModelRef(ref).modelId
}

// The system prompt for a seat's initial answer. Toolless deliberation: the
// seat answers the question directly and standalone (no tools, no follow-ups).
const ANSWER_SYSTEM =
  'You are one member of an expert council answering a user question independently. ' +
  'Give your single best, self-contained answer -- thorough but focused. You have no ' +
  'tools and cannot ask follow-up questions; answer with your own knowledge and reasoning.'

// The system prompt for a peer-review round. The reviewer sees the other
// members' answers ONLY as "Response A/B/..." -- never a model name.
const REVIEW_SYSTEM =
  'You are peer-reviewing anonymous responses to a user question, each labeled only ' +
  '"Response A", "Response B", etc. You do not know which model wrote which -- do not ' +
  'guess. For each response, give a brief, honest critique (strengths and weaknesses), ' +
  'then rank them from best to worst with a one-line justification for the ranking.'

// The chair's synthesis system prompt. Prompt-enforced structure per design.
const CHAIR_SYSTEM =
  'You are the chair of an expert council. Below are the council members\' answers to ' +
  'the user\'s question (with their model names) and their anonymized peer reviews of ' +
  'each other. Synthesize ONE authoritative answer for the user. Structure it to make ' +
  'the deliberation legible:\n' +
  '- Where the council AGREES (the consensus the user can rely on).\n' +
  '- Where it DISAGREES, and why the disagreement matters for the user.\n' +
  '- Unique insights only one member surfaced.\n' +
  '- Your confidence level on the key claims.\n' +
  'Write the answer directly to the user; do not merely summarize who said what.'

// Prefix a system prompt with the bounded recent-conversation block the
// classifier also uses, so mid-conversation council turns stay on-topic.
function withContext(system: string, contextBlock: string): string {
  return contextBlock.trim()
    ? `${system}\n\nRecent conversation:\n${contextBlock.trim()}`
    : system
}

// Assign anonymized labels to the answers OTHER than the reviewer's own.
// `order` is a permutation of the other-answer indices (injected for
// deterministic tests; runCouncil passes a fresh random shuffle per reviewer so
// label assignment is unpredictable). Pure. Exported for tests.
export function anonymizeForReview(
  reviewerRef: string,
  answers: CouncilSeatAnswer[],
  order?: number[]
): LabeledAnswer[] {
  const others = answers.filter((a) => a.seatRef !== reviewerRef)
  const perm = order ?? shuffleIndices(others.length)
  return perm.map((idx, i) => ({
    label: String.fromCharCode(65 + i),
    seatRef: others[idx].seatRef,
    text: others[idx].text
  }))
}

// A Fisher-Yates permutation of [0, n). Not exported: tests inject `order`.
function shuffleIndices(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// The reviewer-facing prompt body: the original question plus the OTHER answers,
// referenced ONLY by their anonymized labels. Contains no model name/ref -- the
// anonymization guarantee the whole-branch review checks. Pure; exported for tests.
export function buildReviewPrompt(labeled: LabeledAnswer[], userText: string): string {
  const blocks = labeled.map((l) => `### Response ${l.label}\n${l.text}`).join('\n\n')
  return `Original question:\n${userText}\n\nResponses to review:\n\n${blocks}`
}

// The chair-facing prompt body: the question, every seat's answer WITH its model
// name, and every peer review with its anonymization map RESOLVED (so the chair
// can read "Response A" as the model it actually was). Pure; exported for tests.
export function buildChairPrompt(
  userText: string,
  answers: CouncilSeatAnswer[],
  reviews: ResolvedReview[]
): string {
  const answerBlocks = answers
    .map((a) => `### ${seatLabel(a.seatRef)}\n${a.text}`)
    .join('\n\n')
  const reviewBlocks = reviews
    .map((r) => {
      const legend = r.mapping.map((m) => `Response ${m.label} = ${seatLabel(m.seatRef)}`).join('; ')
      const legendLine = legend ? `\n(In this review: ${legend}.)` : ''
      return `### Review by ${seatLabel(r.reviewerRef)}${legendLine}\n${r.text}`
    })
    .join('\n\n')
  const reviewSection = reviewBlocks ? `\n\nPeer reviews:\n\n${reviewBlocks}` : ''
  return `User question:\n${userText}\n\nCouncil answers:\n\n${answerBlocks}${reviewSection}`
}

// Extract plain text from an invoke result / stream chunk's `content` (a bare
// string, or the concatenation of {type:'text'} blocks).
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const raw of content) {
    const b = raw as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

// Normalize a message/chunk's usage_metadata to the {inputTokens,outputTokens}
// shape ursaCouncilUsage/turn_meta expect. null when the provider reported none.
function usageOf(
  msg: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } | undefined
): { inputTokens: number; outputTokens: number } | null {
  const um = msg?.usage_metadata
  if (um && (um.input_tokens != null || um.output_tokens != null)) {
    return { inputTokens: um.input_tokens ?? 0, outputTokens: um.output_tokens ?? 0 }
  }
  return null
}

// The honest error shown when the council cannot convene (no keyed seats, or no
// chair key, or every seat failed). Recoverable -- the user can add a key and
// retry, or switch modes.
const COUNCIL_UNAVAILABLE =
  'Council mode needs at least one keyed council seat (OpenAI, Google, or xAI) and the ' +
  'chair (Anthropic). Add the missing API key(s) in Settings > Providers, or switch modes.'

// Run one full council turn. Emits council_seat events (answers + reviews),
// streams the chair's synthesis as the turn's normal assistant_text, books
// per-call usage on turn_meta.ursaCouncilUsage (seats + reviews) plus the
// chair's own usage in the normal slot, and drives the conversation to its
// terminal state itself (like closeOutTurn). Never pauses. `signal` aborts every
// in-flight call at any stage; a failed seat degrades (drops from later stages)
// rather than failing the turn.
export async function runCouncil(
  conversationId: string,
  userText: string,
  sink: RunSink,
  signal: AbortSignal
): Promise<{ paused: boolean; failed?: boolean }> {
  const emit = (event: Event): void => {
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
  }
  const startedAt = Date.now()

  const seats = eligibleSeats()
  const chairProvider = parseModelRef(COUNCIL_CHAIR).provider
  const chairKeyed = keyStatus()[chairProvider]
  if (seats.length === 0 || !chairKeyed) {
    emit({ type: 'error', id: randomUUID(), message: COUNCIL_UNAVAILABLE, recoverable: true })
    sink.setState(conversationId, 'error')
    return { paused: false, failed: true }
  }

  const contextBlock = getRecentUrsaContext(conversationId)
  // One entry per seat call (answers + reviews) so the cost popover books every
  // deliberation call; the chair's usage goes in turn_meta.usage instead.
  const councilUsage: Array<{ modelRef: string; inputTokens: number; outputTokens: number }> = []

  try {
    // ---- Stage 1: answers (parallel, toolless) ----------------------------
    const answered = await Promise.all(
      seats.map(async (seatRef): Promise<CouncilSeatAnswer | null> => {
        const id = randomUUID()
        try {
          const res = await makeModel(seatRef).invoke(
            [new SystemMessage(withContext(ANSWER_SYSTEM, contextBlock)), new HumanMessage(userText)],
            { signal }
          )
          const text = contentText((res as { content: unknown }).content)
          const u = usageOf(res as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
          if (u) councilUsage.push({ modelRef: seatRef, ...u })
          emit({
            type: 'council_seat',
            id,
            seat: seatLabel(seatRef),
            modelRef: seatRef,
            stage: 'answer',
            text,
            status: 'done',
            createdAt: Date.now()
          })
          return text.trim() ? { seatRef, text } : null
        } catch (err) {
          if (signal.aborted) throw err
          emit({
            type: 'council_seat',
            id,
            seat: seatLabel(seatRef),
            modelRef: seatRef,
            stage: 'answer',
            text: '',
            status: 'failed',
            createdAt: Date.now()
          })
          return null
        }
      })
    )
    const answers = answered.filter((a): a is CouncilSeatAnswer => a !== null)
    if (answers.length === 0) {
      emit({
        type: 'error',
        id: randomUUID(),
        message: 'Every council seat failed to answer. Try again.',
        recoverable: true
      })
      sink.setState(conversationId, 'error')
      return { paused: false, failed: true }
    }

    // ---- Stage 2: anonymized peer review (skip when <2 answers) ------------
    let reviews: ResolvedReview[] = []
    if (answers.length >= 2) {
      const reviewed = await Promise.all(
        answers.map(async (reviewer): Promise<ResolvedReview | null> => {
          const mapping = anonymizeForReview(reviewer.seatRef, answers)
          if (mapping.length === 0) return null
          const id = randomUUID()
          try {
            // NO conversation-context block here (unlike stage 1): on turn 2+
            // the context contains the prior chair synthesis, which names the
            // seat models -- feeding it to a reviewer would leak identities
            // through history and break anonymization (final-review finding).
            // Reviewers judge the labeled answers on their merits alone.
            const res = await makeModel(reviewer.seatRef).invoke(
              [
                new SystemMessage(REVIEW_SYSTEM),
                new HumanMessage(buildReviewPrompt(mapping, userText))
              ],
              { signal }
            )
            const text = contentText((res as { content: unknown }).content)
            const u = usageOf(
              res as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }
            )
            if (u) councilUsage.push({ modelRef: reviewer.seatRef, ...u })
            emit({
              type: 'council_seat',
              id,
              seat: seatLabel(reviewer.seatRef),
              modelRef: reviewer.seatRef,
              stage: 'review',
              text,
              status: 'done',
              createdAt: Date.now()
            })
            return text.trim() ? { reviewerRef: reviewer.seatRef, text, mapping } : null
          } catch (err) {
            if (signal.aborted) throw err
            // A failed review is skipped silently (design §5): the chair works
            // with whatever reviews arrived; no failed council_seat is emitted
            // for a review, unlike an answer.
            return null
          }
        })
      )
      reviews = reviewed.filter((r): r is ResolvedReview => r !== null)
    }

    // ---- Stage 3: chair synthesis (streamed as the turn's main answer) -----
    const answerId = randomUUID()
    let answerText = ''
    let merged: AIMessageChunk | undefined
    const stream = await makeModel(COUNCIL_CHAIR).stream(
      [
        new SystemMessage(CHAIR_SYSTEM),
        new HumanMessage(buildChairPrompt(userText, answers, reviews))
      ],
      { signal }
    )
    for await (const chunk of stream) {
      const delta = contentText((chunk as { content: unknown }).content)
      if (delta) {
        answerText += delta
        sink.emit(conversationId, textDeltaEvent(answerId, answerText))
      }
      merged = merged ? (merged.concat(chunk) as AIMessageChunk) : (chunk as AIMessageChunk)
    }
    // Persist the merged answer once (deltas above were emit-only, upserted by
    // id in the renderer -- same pattern as the agent path's drive()).
    appendEvent(conversationId, textDeltaEvent(answerId, answerText))
    const chairUsage = usageOf(
      merged as { usage_metadata?: { input_tokens?: number; output_tokens?: number } } | undefined
    )

    const turnMeta: Event = {
      type: 'turn_meta',
      id: randomUUID(),
      provider: chairProvider,
      model: parseModelRef(COUNCIL_CHAIR).modelId,
      startedAt,
      endedAt: Date.now(),
      ...(chairUsage
        ? { usage: { ...chairUsage, lastInputTokens: chairUsage.inputTokens } }
        : {}),
      ursaRole: 'council',
      ...(councilUsage.length > 0 ? { ursaCouncilUsage: councilUsage } : {})
    }
    emit(turnMeta)
    // Fire-and-forget title generation, mirroring graph.ts closeOutTurn --
    // without this a conversation whose FIRST turn convenes a council never
    // gets an auto title (final-review finding). Titles run on the chair's
    // provider's cheap model.
    if (!signal.aborted) {
      void maybeGenerateTitle(conversationId, chairProvider, parseModelRef(COUNCIL_CHAIR).modelId, userText, answerText, (id) => {
        const meta = getConversationMeta(id)
        if (meta) sink.metaChanged(meta)
      })
    }
    sink.setState(conversationId, signal.aborted ? 'cancelled' : 'done')
    return { paused: false }
  } catch (err) {
    const cancelled = signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[bearcode] council run failed (${conversationId}):`, message)
    emit({ type: 'error', id: randomUUID(), message, recoverable: true })
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
    return { paused: false, failed: true }
  }
}
