// The orchestrator's streaming graph: createDeepAgent() is called with a
// custom filesystem backend factory (fsBackend.ts: per-tool-call
// GatedDiffFsBackend wrappers around one shared DiffFsBackend that routes
// writes through src/main/diffs.ts stageFile) and one custom tool (tools.ts,
// run_command, gated behind a LangGraph interrupt for approval). Deep Agents
// always injects its own built-ins on top of that (the write_todos planning
// tool, filesystem tools backed by our custom backend, and a `task` subagent
// tool). Token streaming (text/reasoning deltas) is bridged into BearCode's
// existing Event contract and RunSink as before; this task adds tool_call /
// tool_result Events for every tool invocation (built-in or custom) and the
// command-approval interrupt/resume flow (risk 4) plus the diff-backed
// filesystem backend (risk 5).
import { randomUUID } from 'crypto'
import { relative } from 'path'
import { existsSync } from 'fs'
import { createDeepAgent } from 'deepagents'
import { Command } from '@langchain/langgraph'
import type { AIMessageChunk, BaseMessageChunk, ToolMessageChunk } from '@langchain/core/messages'
import { isToolMessageChunk } from '@langchain/core/messages'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'
import type {
  AttachmentRef,
  CommandRef,
  Event,
  MentionRef,
  PermissionMode,
  PlanReviewResolveResult,
  ProviderId,
  ToolName
} from '../../shared/types'
import { PDF_MIME } from '../../shared/types'
import type { RunSink } from '../sink'
import {
  appendEvent,
  appendOrReplaceEvent,
  dropDanglingApprovalRows,
  dropDanglingCancel,
  getConversationMeta,
  getEvents,
  listArtifactComments,
  markArtifactCommentsSent,
  setActiveRules,
  setPermissionMode,
  touchedFilesFor
} from '../db'
import { readAttachmentBase64, readAttachmentSidecar } from '../attachments/ingest'
import { loadAgentsContent } from '../agentsDir'
import type { Workflow } from '../agentsDir/types'
import {
  assembleCommandAdditions,
  assembleRuleAdditions,
  assembleUserMentions,
  mentionedFilePaths,
  mentionedRuleNames,
  mergeActiveRules,
  withoutModelRules
} from './contextAssembly'
import { parseModelRef, supportsNativePdf } from '../providers/registry'
import { maybeGenerateTitle } from '../title'
import { renderPlanFeedback } from '../artifacts/feedback'
import { makeModel } from './models'
import { compactionAdvanced } from './compaction'
import {
  COMPACT_ACK_DIRECTIVE,
  commandForcesCompact,
  consumeForceCompact,
  markForceCompact
} from './forceCompact'
import {
  buildTunedSummarization,
  defaultStateBackendFactory,
  excludeDefaultSummarization,
  tunesSummarization
} from './summarizer'
import { orchestratorSystemPrompt } from './systemPrompt'
import { textDeltaEvent, thinkingDeltaEvent } from './bridge'
import { makeTurnUsage, readUsage, type TurnUsageAccumulator } from './usage'
import { getCheckpointer } from './checkpointer'
import { DiffFsBackend, GatedDiffFsBackend } from './fsBackend'
import {
  buildTools,
  clearAllPlanReviewPending,
  clearDeniedReplayPins,
  clearPlanReviewPending,
  pinDeniedReplays,
  type PlanReviewResolution
} from './tools'

// The tuple shape yielded by `.stream(..., { streamMode: "messages", subgraphs: true })`
// with a single (non-array) streamMode: [namespace, [chunk, metadata]]. (The
// 3-tuple with a leading mode string only appears when streamMode is an array
// of multiple modes; verified against StreamOutputMap in
// @langchain/langgraph/dist/pregel/types.d.ts.)
type MessagesStreamChunk = [string[], [BaseMessageChunk, Record<string, unknown>]]

// One named subagent, registered via createDeepAgent's `subagents` option
// (planning/replatform-api-notes.md section (a), `SubAgent` interface,
// deepagents/dist/agent-DURA4_mf.d.ts ~1342). A short, distinct instruction
// so a delegating prompt reliably invokes it through the built-in `task`
// tool rather than the main agent answering directly.
const RESEARCHER_SUBAGENT = {
  name: 'researcher',
  description:
    'Delegate research-style lookups here: gathering and summarizing facts on a topic. ' +
    'Use the task tool with subagent_type "researcher" whenever the user asks you to ' +
    'delegate research or a summary to a subagent.',
  systemPrompt:
    'You are a focused research assistant. Given a topic, produce a concise, ' +
    'factual summary. Do not ask clarifying questions; answer with what you know.'
}

// Known subagent names. Includes our one named subagent PLUS deepagents'
// built-in "general-purpose" subagent (GENERAL_PURPOSE_SUBAGENT.name,
// deepagents/dist/langsmith-wdF8zG42.js ~2286).
//
// Task 8 review fix: `createDeepAgent()`'s exposed `CreateDeepAgentParams`
// (deepagents/dist/agent-DURA4_mf.d.ts ~2518-2653) has NO `generalPurposeAgent`
// boolean -- that flag only exists on the internal `SubAgentMiddlewareOptions`
// consumed by `createSubAgentMiddleware` (~1502), which `createDeepAgent`
// itself always calls with `generalPurposeAgent: false` (langsmith-wdF8zG42.js
// ~5814-5820) because it pre-injects the GP subagent into `inlineSubagents`
// beforehand. That injection (~5788-5803) is unconditional unless EITHER a
// model-derived harness profile sets `generalPurposeSubagent.enabled === false`
// (not something this call site controls -- it's keyed off the model
// identifier, not a createDeepAgent param) OR our own `subagents` array
// already contains an entry literally named "general-purpose" (~5792). So
// there is no way to pass a simple option here to suppress it; the real
// second registered subagent (findings above) is unavoidable with this
// deepagents version. Per the review's documented fallback, allowlist it
// instead of trying to disable it, so a "general-purpose" delegation gets
// its own attributed pill rather than silently merging into the main
// agent's stream.
const SUBAGENT_NAMES = new Set([RESEARCHER_SUBAGENT.name, 'general-purpose'])

// Derive the producing agent's id from a streamed chunk's metadata (and, as
// documentation, its namespace). VERIFIED LIVE (BEARCODE_DEBUG_NS, Task 8):
//
//   - The MAIN agent's model chunks arrive under namespace
//     ["model_request:<uuid>"] with metadata.lc_agent_name === undefined.
//   - A SUBAGENT's chunks (the deep agent's built-in `task` tool invokes the
//     subagent via subagent.invoke(); deepagents/dist/langsmith-*.js
//     createTaskTool sets `metadata.lc_agent_name = subagent_type` on the
//     nested config) arrive under a NESTED namespace
//     ["tools:<uuid>", "model_request:<uuid>"] with
//     metadata.lc_agent_name === "researcher".
//
// So the subagent NAME is NOT in the namespace path (only a generic "tools:"
// segment is) -- the authoritative, name-carrying signal is
// `metadata.lc_agent_name`. We read it and allowlist it against the actually-
// registered subagent names, so an unexpected value can never become a bogus
// pill. This also inherently satisfies the "model_request:<uuid> must never
// become an agentId" guard (Task 5 recon): the main model node carries no
// lc_agent_name, so it falls through to `undefined` (main, unset agentId).
function agentIdOf(metadata: Record<string, unknown>): string | undefined {
  const name = metadata?.lc_agent_name
  if (typeof name === 'string' && SUBAGENT_NAMES.has(name)) return name
  return undefined
}

// Pull the reasoning text out of a streamed content block. Two shapes are
// observed live from the deep agent stream:
//   1. A standardized `reasoning` block ({ type: "reasoning", reasoning }):
//      populated by providers/adapters that normalize thinking (verified in
//      @langchain/core content/index.d.ts).
//   2. A provider-specific `non_standard` block whose `value.type === "thinking"`
//      carries the incremental Anthropic thinking-delta text in `value.thinking`
//      (observed live: @langchain/anthropic streams extended-thinking deltas
//      this way before they are normalized). Signature-only deltas have no
//      `thinking` field, so we guard on a non-empty string.
function reasoningTextOf(block: { type: string; reasoning?: string; value?: unknown }): string {
  if (block.type === 'reasoning') return block.reasoning ?? ''
  if (block.type === 'non_standard') {
    const value = block.value as { type?: string; thinking?: unknown } | undefined
    if (value?.type === 'thinking' && typeof value.thinking === 'string') return value.thinking
  }
  return ''
}

// `agent.getState()` is real at runtime (it delegates to the compiled
// Pregel graph LangGraph Platform relies on) but is typed `never` on
// ReactAgent/DeepAgent -- the JSDoc on langchain/dist/agents/ReactAgent.d.ts
// says this is deliberate ("internal methods... intentionally return never
// to avoid type errors due to type inference"), not a runtime restriction.
// This cast is the documented workaround for calling it anyway.
interface StateSnapshotLike {
  tasks: ReadonlyArray<{ interrupts: ReadonlyArray<{ id?: string; value?: unknown }> }>
  values?: {
    messages?: ReadonlyArray<unknown>
    // Set by the deepagents summarization middleware via Command.update when it
    // folds the oldest `cutoffIndex` messages into a summary (auto-compaction).
    _summarizationEvent?: { cutoffIndex?: number }
  }
}
type GetStateCapable = { getState(config: unknown): Promise<StateSnapshotLike> }

// Every pending interrupt in the thread's checkpointed state. Parallel tool
// calls each run as their own Send/PUSH Pregel task (langchain ReactAgent v2
// dispatch), so N approval-requiring run_commands raised in the same superstep
// surface as N task interrupts, each with its own id -- the XXH3-128 hash of
// the task's checkpoint namespace (langgraph dist/interrupt.js), which is what
// a keyed `Command({ resume: { [id]: value } })` targets. Deterministic, so it
// stays valid across a process restart. Interrupts without an id are skipped:
// a keyed resume cannot address them (checkpointed task interrupts always
// carry one in practice). `messages` is the same snapshot's checkpointed
// message history, carried along so the crash-resume path can locate the
// paused tool calls without a second getState round-trip.
interface PendingInterrupt {
  interruptId: string
  value: unknown
}

async function findPendingInterrupts(
  agent: unknown,
  threadId: string
): Promise<{ interrupts: PendingInterrupt[]; messages: ReadonlyArray<unknown> }> {
  const snapshot = await (agent as GetStateCapable).getState({
    configurable: { thread_id: threadId }
  })
  const interrupts: PendingInterrupt[] = []
  for (const task of snapshot.tasks) {
    for (const it of task.interrupts) {
      if (it.id) interrupts.push({ interruptId: it.id, value: it.value })
    }
  }
  return { interrupts, messages: snapshot.values?.messages ?? [] }
}

interface DriveContext {
  conversationId: string
  sink: RunSink
  providerId: ProviderId
  modelId: string
  startedAt: number
  userText: string
  projectPath: string
  backend: DiffFsBackend
  diffGroupId: string
  signal: AbortSignal
  writeCursor: { i: number }
  // Local event ids (see callIdMap below) whose tool_call Event has already
  // been emitted by the caller (the approval resume path emits the
  // 'approved'/'denied' update itself, before re-driving the stream) so
  // drive() doesn't double-emit.
  alreadyAnnounced: Set<string>
  // Provider tool-call id (tc.id, e.g. LangChain/OpenRouter's own id, which
  // can repeat across iterations for non-Anthropic providers) -> a locally
  // minted uuid used as the Event id everywhere. `events.id` is a GLOBAL
  // PRIMARY KEY across all conversations (src/main/db/index.ts), so reusing
  // the provider's id verbatim collides once it repeats (legacy run.ts
  // around line 293 has the same fix: `const evId = randomUUID()`). This
  // map is shared by reference across the pause/resume split (the same
  // DriveContext, and thus the same Map, is threaded through
  // pendingApprovals/continueAfterApproval) so the tool_call emitted before
  // the pause and the tool_result emitted after resume pair on the same id.
  callIdMap: Map<string, string>
  // The main agent's final answer text, accumulated across every drive()
  // segment of the turn (a turn can span multiple segments when it pauses on
  // approval and resumes). Boxed so it's shared by reference across the
  // pause/resume split like callIdMap above; closeOutTurn reads it for title
  // generation, which otherwise saw only the user's prompt (the running answer
  // accumulator is local to each drive() call and didn't survive the pause).
  answerAccum: { text: string }
  // Timestamp of the first answer-text token of the current model call, boxed so
  // the ReasoningBridgeHandler (constructed alongside) can read it to time the
  // "Thought for Ns" step as call-start -> answer-start. Reset per call by the
  // handler's handleLLMStart.
  answerStartedAt: { t: number | null }
  // Tool calls captured from handleLLMEnd, a fallback for providers whose stream
  // strips them. Gemini bundles its tool call into a thought-bearing chunk, and
  // Deep Agents drops those from streamMode:messages (the same reason reasoning is
  // bridged, above) -- so aiMsg.tool_calls is empty and the post-loop would
  // surface nothing (no tool_call event, and the run_command interrupt is never
  // detected, so approval never prompts). handleLLMEnd keeps the full message, so
  // the ReasoningBridgeHandler records tool calls here for the post-loop to use as
  // a fallback. Keyed by tool-call id (dedup across the parent+child
  // handleLLMEnd double-fire); insertion order preserved. Shared by reference
  // across the pause/resume split like callIdMap, so a resumed segment still sees
  // the paused tool call. Entries are pruned once their result is processed
  // (processToolCall), so a later segment never re-iterates a completed call
  // as a stale no-result candidate for a new pending interrupt.
  bridgedToolCalls: Map<string, { id: string; name: string; args: unknown }>
  // Final answer text captured from handleLLMEnd, a fallback for providers
  // whose stream strips it: Gemini can bundle the final text into
  // thought-bearing chunks that Deep Agents drops from streamMode:messages,
  // the same mechanism as bridgedToolCalls above (Bug A cause 2). Boxed and
  // shared by reference across the pause/resume split like answerAccum.
  // drive() emits it at un-paused segment end only when the streamed answer
  // does not already contain it (shouldEmitBridgedText).
  bridgedAnswerText: { text: string }
  // One-shot guard for the empty-final recovery nudge (Bug A cause 1). Boxed
  // and shared across the pause/resume split so a turn never nudges twice,
  // even if the nudge segment itself pauses on an approval and resumes.
  emptyFinalRetried: { done: boolean }
  // Accumulates real per-call token usage across the turn (handleLLMEnd). Deduped
  // by the parent/child runId link (handleLLMEnd double-fires one call under two
  // runIds); snapshot() lands on turn_meta.usage. Shared by reference across the
  // pause/resume split like the other boxed accumulators above.
  turnUsage: TurnUsageAccumulator
}

// One approval card a paused segment surfaced: callId is the pending
// tool_call event's id (the approval lifecycle's single event id),
// interruptId is the checkpointed interrupt the eventual keyed resume targets,
// toolCallId the provider tool-call id (when known) so a Denied decision can
// be pinned against the exact replayed call (tools.ts deniedReplayPins).
interface PendingItem {
  callId: string
  interruptId: string
  tool: ToolName
  input: unknown
  toolCallId?: string
  // Present iff this card is a plan_review pause. `resolution` is recorded by
  // resolvePlanInterrupt and is what buildResumeMap delivers to the suspended
  // submit_plan interrupt -- the kind-branched resume shape. Command/edit
  // items keep using `decision`; the two are mutually exclusive.
  planReview?: { artifactId: string; resolution?: PlanReviewResolution }
}

interface DriveResult {
  paused: boolean
  pending?: PendingItem[]
}

const emitAndPersist = (conversationId: string, sink: RunSink, event: Event): void => {
  sink.emit(conversationId, event)
  appendEvent(conversationId, event)
}

// Pull thinking text out of a completed message's content array. Deep Agents
// surfaces reasoning here (handleLLMEnd) as {type:"thinking"} (Gemini) or the
// standardized {type:"reasoning"} block; guard both.
function thinkingTextOfMessage(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const raw of content) {
    const b = raw as { type?: string; thinking?: unknown; reasoning?: unknown }
    if (b.type === 'thinking' && typeof b.thinking === 'string') out += b.thinking
    else if (b.type === 'reasoning' && typeof b.reasoning === 'string') out += b.reasoning
  }
  return out
}

// Pull plain answer text out of a completed message's content (handleLLMEnd):
// either a bare string, or the concatenation of {type:"text"} blocks in a
// content array. Counterpart of thinkingTextOfMessage above, for the answer-
// text bridge (Bug A cause 2). Exported for tests.
export function textOfMessage(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const raw of content) {
    const b = raw as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

// Per-file 256 KB caps live at ingest (extract.ts); this is the turn-time
// AGGREGATE budget across ALL inlined sections, so N large attachments can't
// overflow a small-context model (Haiku 200K / local). Tunable.
export const MAX_INLINE_TEXT_BYTES_TOTAL = 512 * 1024

type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source_type: 'base64'; mime_type: string; data: string }
  | {
      type: 'file'
      source_type: 'base64'
      mime_type: string
      data: string
      metadata: { filename: string }
    }

// A single titled, fenced text section for an inlined attachment (D5 §1b/1e).
function titledSection(a: AttachmentRef, text: string): string {
  const label = (a.kind ?? 'image') === 'office' ? 'Attached document' : 'Attached file'
  return `## ${label}: ${a.name}\n\`\`\`\n${text}\n\`\`\``
}

// Build the human-message `content` for one turn (D5). Lane-aware but keeps the
// string-vs-array contract: with no image/native-pdf blocks it returns a plain
// string (unchanged D4 behaviour for text-only turns). text/office/pdf-fallback
// attachments are inlined as titled sections (subject to the aggregate budget);
// images ride native image blocks; PDFs on a capable provider ride a native
// {type:'file'} document block with metadata.filename (required by OpenAI, and
// carried harmlessly for Anthropic/Google). PURE: readers are injected.
export function buildUserMessageContent(
  modelText: string,
  attachments: AttachmentRef[],
  readBytesBase64: (a: AttachmentRef) => string | null,
  readSidecarText: (a: AttachmentRef) => string | null,
  opts: { pdfNative: boolean }
): string | UserContentBlock[] {
  // 1. Inlined text sections (text, office, and pdf when NOT going native),
  //    in attach order, capped to the aggregate budget.
  let usedBytes = 0
  let budgetHit = false
  const sections: string[] = []
  for (const a of attachments) {
    // Back-compat: a pre-D5 persisted ref has no `kind` and MUST read as
    // 'image' (global correction) -- never branch on a possibly-undefined kind.
    const kind = a.kind ?? 'image'
    const inlineThisPdf = kind === 'pdf' && !opts.pdfNative
    if (kind !== 'text' && kind !== 'office' && !inlineThisPdf) continue
    const text = readSidecarText(a)
    if (text === null) {
      sections.push(`(could not read ${a.name})`)
      continue
    }
    if (budgetHit) {
      sections.push(`## ${a.name}: … (omitted: inlined-content budget reached)`)
      continue
    }
    const remaining = MAX_INLINE_TEXT_BYTES_TOTAL - usedBytes
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > remaining) {
      const clipped = Buffer.from(text, 'utf8').subarray(0, Math.max(0, remaining)).toString('utf8')
      sections.push(titledSection(a, clipped) + '\n… (truncated: inlined-content budget reached)')
      budgetHit = true
      usedBytes = MAX_INLINE_TEXT_BYTES_TOTAL
      continue
    }
    sections.push(titledSection(a, text))
    usedBytes += bytes
  }
  const augmentedText = sections.length > 0 ? `${modelText}\n\n${sections.join('\n\n')}` : modelText

  // 2. Native multimodal blocks: images, and native PDFs on capable providers.
  const mediaBlocks: UserContentBlock[] = []
  for (const a of attachments) {
    const kind = a.kind ?? 'image'
    if (kind === 'image') {
      const data = readBytesBase64(a)
      if (data === null) continue
      mediaBlocks.push({ type: 'image', source_type: 'base64', mime_type: a.mime, data })
    } else if (kind === 'pdf' && opts.pdfNative) {
      const data = readBytesBase64(a)
      if (data === null) continue
      mediaBlocks.push({
        type: 'file',
        source_type: 'base64',
        mime_type: PDF_MIME,
        data,
        metadata: { filename: a.name }
      })
    }
  }

  if (mediaBlocks.length === 0) return augmentedText
  return [{ type: 'text', text: augmentedText }, ...mediaBlocks]
}

// Pure decision for the answer-text bridge: emit only when handleLLMEnd
// captured text AND the streamed answer does not already contain it. Providers
// whose stream carries the text (kimi/openai/anthropic) accumulate the exact
// same tokens handleLLMEnd sees, so containment is exact and the bridge stays
// silent -- this guard is what prevents a double-emit. Exported for tests.
export function shouldEmitBridgedText(bridged: string, streamedAnswer: string): boolean {
  return bridged !== '' && !streamedAnswer.includes(bridged)
}

// Attribution guard for a pending interrupt: a run_command interrupt carries
// the exact command string the tool received (tools.ts passes the zod-parsed
// `command` verbatim), so a candidate tool call only owns the interrupt when
// it is a run_command with that same command. Without this check, a stale
// bridged entry left over from an earlier drive() segment (or a parallel
// sibling that never ran) would claim a NEW interrupt: the approval card
// shows the stale command while approving resumes -- and executes -- the new,
// unseen one. An edit_file interrupt (fsBackend.ts's GatedDiffFsBackend)
// works the same way: the candidate must be the exact write tool the gate
// interrupted for, matched by the payload's toolCallId when it carries one
// (exact, never falling back) and otherwise by the RAW agent path -- the
// payload's `path` is the string the model sent, so it is what the streamed
// tool_call args contain; `resolvedPath` is display-only and never
// participates in pairing (Task 3 review carry-forward). Unknown interrupt
// kinds pass (nothing to verify against). Exported for tests.
export function interruptBelongsToToolCall(
  interruptValue: unknown,
  tc: { id?: string; name?: string; args?: unknown }
): boolean {
  const value = interruptValue as
    | {
        kind?: string
        command?: string
        tool?: string
        path?: string
        title?: string
        toolCallId?: unknown
      }
    | null
    | undefined
  if (value?.kind === 'run_command') {
    if (tc.name !== 'run_command') return false
    return (tc.args as { command?: unknown } | null | undefined)?.command === value.command
  }
  if (value?.kind === 'edit_file') {
    if (tc.name !== value.tool) return false
    if (typeof value.toolCallId === 'string') return tc.id === value.toolCallId
    const args = tc.args as { file_path?: unknown; path?: unknown } | null | undefined
    return (args?.file_path ?? args?.path) === value.path
  }
  // F8 outside-folder read approval ('ask' fileAccessPolicy). Same pairing as
  // edit_file: the candidate must be the exact read tool the gate interrupted
  // for, matched by toolCallId when present (always is, from the backend
  // factory) and otherwise by the RAW agent path the streamed args carry.
  if (value?.kind === 'read_file') {
    if (tc.name !== value.tool) return false
    if (typeof value.toolCallId === 'string') return tc.id === value.toolCallId
    const args = tc.args as { file_path?: unknown; path?: unknown } | null | undefined
    return (args?.file_path ?? args?.path) === value.path
  }
  if (value?.kind === 'plan_review') {
    if (tc.name !== 'submit_plan') return false
    if (typeof value.toolCallId === 'string') return tc.id === value.toolCallId
    // Id-less fallback: the tool args carry no artifactId, so the title is the
    // pairing analog of run_command's command match (the payload's title is
    // the zod-parsed title the tool received, verbatim).
    return (tc.args as { title?: unknown } | null | undefined)?.title === value.title
  }
  return true
}

// The plan_review payload's artifactId, or undefined for any other kind.
// Exported for tests; shared by drive()'s post-loop and rehydratePausedRun.
export function planReviewArtifactIdOf(interruptValue: unknown): string | undefined {
  const value = interruptValue as { kind?: string; artifactId?: unknown } | null | undefined
  return value?.kind === 'plan_review' && typeof value.artifactId === 'string'
    ? value.artifactId
    : undefined
}

// Locate the checkpointed tool calls a rehydrated approval set belongs to
// (crash-resume): every AI-message run_command tool_call with no matching
// ToolMessage anywhere in the history (by tool_call_id) is a call the graph
// paused on, returned in message order so pairing consumes them in issue
// order. Pure and structural (the entries are LangChain BaseMessages at
// runtime, but only `tool_calls` and `tool_call_id` are read) so it is
// testable without LangGraph. Exported for tests.
export function findDanglingRunCommandCalls(
  messages: ReadonlyArray<unknown>
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const answered = new Set<string>()
  for (const raw of messages) {
    const msg = raw as { tool_call_id?: unknown } | null | undefined
    if (typeof msg?.tool_call_id === 'string') answered.add(msg.tool_call_id)
  }
  const dangling: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  for (const raw of messages) {
    const calls = (raw as { tool_calls?: unknown } | null | undefined)?.tool_calls
    if (!Array.isArray(calls)) continue
    for (const rawTc of calls) {
      const tc = rawTc as { id?: unknown; name?: unknown; args?: unknown } | null | undefined
      if (typeof tc?.id !== 'string' || answered.has(tc.id)) continue
      if (tc.name !== 'run_command') continue
      dangling.push({
        id: tc.id,
        name: 'run_command',
        args: (tc.args ?? {}) as Record<string, unknown>
      })
    }
  }
  return dangling
}

// Pair each pending interrupt to the tool call that raised it. The interrupt
// payload's `toolCallId` (tools.ts includes the provider tool-call id ToolNode
// hands the tool) is authoritative when present: it disambiguates even two
// identical parallel commands, and when it names a call that is not in the
// candidate list the interrupt deliberately pairs to NOTHING rather than
// falling back to a command match that could claim a stale sibling -- this is
// the approval gate, so a card must never show one command while its decision
// resumes another. The command match (interruptBelongsToToolCall) is only the
// fallback for payloads without a toolCallId (pre-existing checkpoints,
// stripped calls), consuming unclaimed candidates in order. An unpaired
// interrupt gets `call: null`; the caller synthesizes its card from the
// payload's command. Pure; exported for tests.
export interface InterruptPairing {
  interruptId: string
  value: unknown
  call: { id: string; name?: string; args?: unknown } | null
}
export function pairInterruptsToCalls(
  interrupts: ReadonlyArray<{ interruptId: string; value: unknown }>,
  calls: ReadonlyArray<{ id?: string; name?: string; args?: unknown }>
): InterruptPairing[] {
  const claimed = new Set<string>()
  return interrupts.map((it) => {
    const toolCallId = (it.value as { toolCallId?: unknown } | null | undefined)?.toolCallId
    const match =
      typeof toolCallId === 'string'
        ? calls.find((c) => c.id === toolCallId && !claimed.has(c.id))
        : calls.find(
            (c) =>
              c.id !== undefined && !claimed.has(c.id) && interruptBelongsToToolCall(it.value, c)
          )
    if (match?.id === undefined) return { interruptId: it.interruptId, value: it.value, call: null }
    claimed.add(match.id)
    return {
      interruptId: it.interruptId,
      value: it.value,
      call: { id: match.id, name: match.name, args: match.args }
    }
  })
}

// The card for an interrupt that paired to no tool call (the call:null
// synthesis in drive()'s post-loop, and every edit interrupt in
// rehydratePausedRun): built entirely from the interrupt payload so the
// approval still surfaces instead of hanging. For edit_file payloads the
// displayed file_path is the jail-RESOLVED workspace-relative path -- a card
// showing 'safe/../.env' while the write lands on '.env' would mislead the
// approver -- and the raw agent string rides along as requested_path when
// the two differ, because the raw string is what the replayed gate call
// receives and therefore what the denied-replay pin must match
// (deniedReplayPinsOf below). The payload's toolCallId (when present) still
// identifies the replayed call exactly, so a Denied decision on a
// synthesized card pins correctly. Exported for tests.
export function synthesizedApprovalCard(interruptValue: unknown): {
  tool: ToolName
  input: unknown
  toolCallId?: string
} {
  const value = interruptValue as
    | {
        kind?: string
        command?: string
        tool?: string
        path?: string
        resolvedPath?: string
        artifactId?: unknown
        title?: string
        toolCallId?: unknown
      }
    | null
    | undefined
  const toolCallId = typeof value?.toolCallId === 'string' ? value.toolCallId : undefined
  if (value?.kind === 'plan_review') {
    // The card is built from the payload alone: title for the copy, artifactId
    // so the renderer can pair the card with the pane's plan viewer (and the
    // Open-in-pane deep link). The body is NOT duplicated here -- the artifact
    // event already carries it.
    // Note the discriminant asymmetry: this branches on `kind` alone, so a
    // malformed payload with a missing/non-string artifactId still produces a
    // 'submit_plan' card (artifactId silently falls back to ''), while
    // planReviewArtifactIdOf above additionally requires a genuine string
    // artifactId and returns undefined for that same payload -- the two
    // readers of this discriminant can disagree on a bad payload.
    return {
      tool: 'submit_plan',
      input: {
        title: typeof value.title === 'string' ? value.title : '',
        artifactId: typeof value.artifactId === 'string' ? value.artifactId : ''
      },
      toolCallId
    }
  }
  if (value?.kind === 'edit_file') {
    const raw = typeof value.path === 'string' ? value.path : undefined
    const resolved = typeof value.resolvedPath === 'string' ? value.resolvedPath : undefined
    const filePath = resolved ?? raw ?? ''
    return {
      tool: value.tool === 'edit_file' ? 'edit_file' : 'write_file',
      input:
        raw !== undefined && raw !== filePath
          ? { file_path: filePath, requested_path: raw }
          : { file_path: filePath },
      toolCallId
    }
  }
  // F8 outside-folder read approval: without this branch an unpaired read_file
  // interrupt fell through to the run_command default below, surfacing a
  // mislabeled empty command card whose approval resumed the outside READ. The
  // card's tool is the payload's read tool so the renderer's read-approval card
  // renders; file_path is the jail-resolved target (raw rides as requested_path).
  if (value?.kind === 'read_file') {
    const READ_TOOLS: ToolName[] = ['read_file', 'ls', 'grep', 'glob']
    const tool = (
      typeof value.tool === 'string' && (READ_TOOLS as string[]).includes(value.tool)
        ? value.tool
        : 'read_file'
    ) as ToolName
    const raw = typeof value.path === 'string' ? value.path : undefined
    const resolved = typeof value.resolvedPath === 'string' ? value.resolvedPath : undefined
    const filePath = resolved ?? raw ?? ''
    return {
      tool,
      input:
        raw !== undefined && raw !== filePath
          ? { file_path: filePath, requested_path: raw }
          : { file_path: filePath },
      toolCallId
    }
  }
  return { tool: 'run_command', input: { command: value?.command ?? '' }, toolCallId }
}

// The pending card input for a PAIRED interrupt (reviewer finding 2 on Task
// 4): run_command cards keep the streamed args verbatim (byte-identical
// events); edit cards get the same resolved-path treatment as
// synthesizedApprovalCard, so the common live case also displays the TRUE
// target -- file_path becomes the payload's jail-resolved path, with the raw
// agent string carried as requested_path only when the two differ (that raw
// string is what deniedReplayPinsOf keys the execution-layer pin on). The
// rest of the streamed args (content/old_string/new_string) survive for the
// card's preview. Pairing itself still matches on the RAW streamed args;
// only the emitted event / parked item input is enriched. An edit payload
// without a resolvedPath (never produced by the Bb3 gate) passes through
// untouched. Exported for tests.
export function pairedApprovalInput(interruptValue: unknown, args: unknown): unknown {
  const value = interruptValue as
    { kind?: string; path?: string; resolvedPath?: string; artifactId?: unknown } | null | undefined
  if (value?.kind === 'plan_review') {
    if (typeof value.artifactId !== 'string') return args
    const base = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    // Enrich the pending card's input with the artifactId (the streamed args
    // are only { title, body }): the pane's Proceed/Review header actions and
    // the card's Open-in-pane link pair on it. Pairing itself already matched
    // on the raw streamed args; only the emitted event / parked item changes
    // (the edit_file precedent above).
    return { ...base, artifactId: value.artifactId }
  }
  // edit_file and read_file (F8) share the resolved-path enrichment so the
  // paired live card also shows the TRUE target instead of the raw agent string
  // (a symlink inside the workspace can make an outside read look in-project).
  if (value?.kind !== 'edit_file' && value?.kind !== 'read_file') return args
  const resolved = typeof value.resolvedPath === 'string' ? value.resolvedPath : undefined
  if (resolved === undefined) return args
  const base = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const raw = typeof value.path === 'string' ? value.path : undefined
  return raw !== undefined && raw !== resolved
    ? { ...base, file_path: resolved, requested_path: raw }
    : { ...base, file_path: resolved }
}

// One card of a parked approval set: the interrupt it resolves, the event
// row's tool/input (so the resolved/denied tool_call re-emits the same card),
// and the user's decision once recorded. Keyed by callId (the tool_call event
// id) in PendingApprovalSet.items.
export interface ApprovalItem {
  interruptId: string
  tool: ToolName
  input: unknown
  toolCallId?: string
  decision?: boolean
  // Present iff this card is a plan_review pause. `resolution` is recorded by
  // resolvePlanInterrupt and is what buildResumeMap delivers to the suspended
  // submit_plan interrupt -- the kind-branched resume shape. Command/edit
  // items keep using `decision`; the two are mutually exclusive.
  planReview?: { artifactId: string; resolution?: PlanReviewResolution }
}

// All-answered detection for collect-then-resume: the batch keyed resume is
// dispatched only once every card has a decision. A plan card is decided by
// its recorded PlanReviewResolution, never by the boolean `decision` field.
// Exported for tests.
export function allDecided(items: ReadonlyMap<string, ApprovalItem>): boolean {
  for (const item of items.values()) {
    const decided = item.planReview
      ? item.planReview.resolution !== undefined
      : item.decision !== undefined
    if (!decided) return false
  }
  return true
}

// The keyed resume map for one dispatch. THE RESUME SHAPE BRANCHES BY KIND
// HERE AND ONLY HERE (security lens): a run_command/edit_file interrupt gets
// the truthy { approved } object its suspended interrupt() expects; a
// plan_review interrupt gets its PlanReviewResolution. The branch keys on the
// parked item's planReview field -- set exclusively from the interrupt
// payload's kind at park time -- never on anything user-supplied, so a
// { approved: true } can never reach a plan interrupt (it would falsely read
// as no-proceed... worse, a { proceed } object reaching run_command would
// read approved:undefined -> falsy -> denied; both directions are pinned by
// tests). Fail-safes: undecided commands resume denied (unchanged); an
// undecided plan item resumes with design 3.5's deny-all value
// { proceed: false, feedback: 'The user stopped the run.' } -- unreachable
// via allDecided, but the honest value if it ever dispatches.
export type ResumeValue = { approved: boolean } | PlanReviewResolution
export function buildResumeMap(
  items: ReadonlyMap<string, ApprovalItem>
): Record<string, ResumeValue> {
  const resume: Record<string, ResumeValue> = {}
  for (const item of items.values()) {
    if (item.planReview) {
      resume[item.interruptId] = item.planReview.resolution ?? {
        proceed: false,
        feedback: 'The user stopped the run.'
      }
    } else {
      resume[item.interruptId] = { approved: item.decision === true }
    }
  }
  return resume
}

// The terminal tool_call rows for one dispatched batch, persisted ONLY at
// dispatch time (once every card is answered), never at per-card decision
// time: the collect window is unbounded, and a decision row persisted before
// the batch resume dispatches would survive an app quit as a lie -- an
// 'approved' row for a command that never executed -- which the next boot's
// rehydrate then duplicates with a fresh pending card for the same interrupt.
// Same fail-safe as buildResumeMap: an impossible undecided item persists as
// denied. Exported for tests.
export function resolvedToolCallEvents(
  items: ReadonlyMap<string, ApprovalItem>
): Extract<Event, { type: 'tool_call' }>[] {
  // Plan vocabulary: 'denied' = resolved-without-proceed (feedback or Stop);
  // the renderer's plan card renders its own copy. The artifact row is NOT
  // touched here -- feedback leaves it pending-review by design (3.1).
  return [...items].map(([callId, item]) => ({
    type: 'tool_call',
    id: callId,
    tool: item.tool,
    input: item.input,
    approvalState: (
      item.planReview ? item.planReview.resolution?.proceed === true : item.decision === true
    )
      ? 'approved'
      : 'denied'
  }))
}

// The execution-layer deny pins for one dispatched batch (tools.ts
// deniedReplayPins): every card NOT approved, keyed by its provider tool-call
// id when known, with a kind-specific string as the id-less fallback -- the
// command for run_command cards; for write_file/edit_file cards the RAW
// agent path (a synthesized card's requested_path when it carried one, else
// the input's file_path), since the raw string is what the replayed gate
// call receives (fsBackend.ts takeDeniedEditReplayPin). Undecided items pin
// too, matching buildResumeMap's fail-safe-to-denied. Exported for tests.
export function deniedReplayPinsOf(
  items: ReadonlyMap<string, ApprovalItem>
): Array<{ toolCallId?: string; command?: string; editPath?: string }> {
  const pins: Array<{ toolCallId?: string; command?: string; editPath?: string }> = []
  for (const item of items.values()) {
    // NO pin analog for plan_review (decided): pins exist solely so a Denied
    // command/edit replay cannot re-evaluate to run/apply and EXECUTE.
    // submit_plan consults no rules engine and executes nothing; its replay
    // gets the recorded resolution straight from the keyed resume, and its
    // store is idempotent-by-key. A feedback "denial" is an answer to deliver,
    // not an action to block -- pinning it would only plant a stray
    // toolCallId in the shared pin set.
    if (item.planReview) continue
    if (item.decision === true) continue
    if (item.tool === 'write_file' || item.tool === 'edit_file') {
      const input = item.input as
        { file_path?: unknown; requested_path?: unknown; path?: unknown } | null | undefined
      const raw = input?.requested_path ?? input?.file_path ?? input?.path
      pins.push({
        toolCallId: item.toolCallId,
        editPath: typeof raw === 'string' ? raw : undefined
      })
    } else {
      const command = (item.input as { command?: unknown } | null | undefined)?.command
      pins.push({
        toolCallId: item.toolCallId,
        command: typeof command === 'string' ? command : undefined
      })
    }
  }
  return pins
}

// Deny-all on cancel (Stop while parked): one terminal 'denied' tool_call row
// per card, INCLUDING cards already answered 'approved' -- the batch resume
// had not been dispatched, so nothing executed and denied is the truthful
// terminal state; the row replaces any earlier approved row under the same
// event id. Plan cards flip to 'denied' too (resolved-without-proceed); their
// artifact rows stay pending-review -- Stop is not plan rejection (design
// 3.5). Exported for tests.
export function deniedToolCallEvents(
  items: ReadonlyMap<string, ApprovalItem>
): Extract<Event, { type: 'tool_call' }>[] {
  return [...items].map(([callId, item]) => ({
    type: 'tool_call',
    id: callId,
    tool: item.tool,
    input: item.input,
    approvalState: 'denied'
  }))
}

// Order a drive() segment's tool-call candidates so every call that already
// has a result is processed (and its tool_result persisted) BEFORE any
// no-result pause candidate. Without this, a segment that both completes a
// resumed command and pauses on a new one (approve cmd1 -> resume -> cmd1's
// result arrives -> the model asks for cmd2) returns paused off the streamed
// cmd2 before the bridged-fallback iteration ever reaches cmd1, and cmd1's
// result is lost forever: the next segment's fresh toolMsgById has no entry
// for it, so it degrades to the silent no-result/no-interrupt skip. Relative
// order within each group is preserved. Exported for tests.
export function orderCompletedCallsFirst<T extends { tc: { id?: string } }>(
  candidates: ReadonlyArray<T>,
  hasResult: (id: string) => boolean
): T[] {
  const completed: T[] = []
  const rest: T[] = []
  for (const c of candidates) {
    ;(c.tc.id !== undefined && hasResult(c.tc.id) ? completed : rest).push(c)
  }
  return [...completed, ...rest]
}

// Pure decision for the empty-final recovery (Bug A cause 1): retry once when
// the turn actually ran at least one tool but accumulated no answer text.
// Exported for tests.
export function shouldRetryEmptyFinal(
  toolCallCount: number,
  answerText: string,
  alreadyRetried: boolean
): boolean {
  return toolCallCount > 0 && answerText === '' && !alreadyRetried
}

// Reasoning bridge (Phase A1c). Deep Agents' streaming pipeline strips
// thought-bearing chunks from streamMode:"messages" (and on_chat_model_stream):
// the model DOES stream thoughts -- google-genai emits them from
// _streamResponseChunks -- but only the aggregated final message keeps them,
// exposed through each LLM run's handleLLMEnd. (Diagnosed across 8+ isolation
// probes; full writeup in planning/phaseA1-reasoning-diagnosis.md.) So reasoning
// for the orchestrator engine is bridged from handleLLMEnd, not the token
// stream: every completed model call whose message carries thinking emits one
// thinking Event -- the existing "Thought for Ns" step. The streamMode reasoning
// path in drive() stays: it's correct for any provider that DOES stream
// plaintext thinking deltas and is simply inert through Deep Agents.
//
// Two subtleties this handles:
//   - DEDUP: handleLLMEnd fires for BOTH a nested parent run and the child model
//     run, so the same thinking arrives twice with different durations. `seen`
//     keeps only the first emission of each distinct thinking text per turn.
//   - DURATION: the "Thought for Ns" time is the wall-clock the model spent
//     BEFORE it started answering (call start -> first answer token), not the
//     whole call. The whole call includes streaming the answer, which overstates
//     thinking and made "Thought for 6s" appear nested under "Worked for 1s".
//     The drive() loop stamps `answerStartedAt` when the first answer text
//     arrives; handleLLMStart resets it so each call measures its own gap.
class ReasoningBridgeHandler extends BaseCallbackHandler {
  name = 'bearcode-reasoning-bridge'
  private readonly startedAt = new Map<string, number>()
  private readonly seen = new Set<string>()
  constructor(
    private readonly conversationId: string,
    private readonly sink: RunSink,
    private readonly answerStartedAt: { t: number | null },
    private readonly bridgedToolCalls: Map<string, { id: string; name: string; args: unknown }>,
    private readonly bridgedAnswerText: { text: string },
    private readonly turnUsage: TurnUsageAccumulator
  ) {
    super()
  }
  handleLLMStart(_llm: unknown, _prompts: string[], runId: string): void {
    this.startedAt.set(runId, Date.now())
    // A new model call: forget the previous call's answer-start so this call's
    // thinking time is measured against its own first answer token.
    this.answerStartedAt.t = null
  }
  handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): void {
    const started = this.startedAt.get(runId) ?? Date.now()
    this.startedAt.delete(runId)
    const usage = readUsage(output)
    // Pass parentRunId so the accumulator can collapse the parent/child
    // double-fire (same usage, different runIds linked by parentRunId).
    if (usage) this.turnUsage.add(runId, parentRunId, usage)
    let thinking = ''
    for (const gens of output.generations ?? []) {
      for (const gen of gens) {
        const message = (
          gen as {
            message?: {
              content?: unknown
              tool_calls?: { id?: string; name?: string; args?: unknown }[]
            }
          }
        ).message
        thinking += thinkingTextOfMessage(message?.content)
        // Record tool calls the same way, and BEFORE the thinking early-return
        // below: Deep Agents strips them from the stream when they ride in a
        // thought-bearing chunk (Gemini), so the drive() post-loop uses these as a
        // fallback. Dedup by id (handleLLMEnd fires for the parent and child run).
        for (const tc of message?.tool_calls ?? []) {
          if (tc?.id && tc.name && !this.bridgedToolCalls.has(tc.id)) {
            this.bridgedToolCalls.set(tc.id, { id: tc.id, name: tc.name, args: tc.args })
          }
        }
        // Bridge final answer text the same way (Bug A cause 2): a completed
        // model call with NO tool_calls is a final-answer call (an agent loop
        // only continues while tool calls are issued), and Gemini can bundle
        // its text into thought-bearing chunks that the stream drops.
        // Overwrite UNCONDITIONALLY, even with empty text: handleLLMEnd
        // carries no lc_agent_name, so a subagent's final report is captured
        // here too in delegation turns -- but the MAIN agent's final always
        // fires last, so letting an empty main final clear a captured
        // subagent report is what keeps that report from surfacing as the
        // main answer (and from suppressing settleTurn's empty-final nudge).
        // The parent/child handleLLMEnd double-fire carries the same text, so
        // latest-wins is stable.
        if ((message?.tool_calls ?? []).length === 0) {
          this.bridgedAnswerText.text = textOfMessage(message?.content)
        }
      }
    }
    if (!thinking || this.seen.has(thinking)) return
    this.seen.add(thinking)
    // Thinking wall-clock = call start until the answer began (falls back to the
    // whole call if this call never produced answer text, e.g. a pure tool step).
    const answerAt = this.answerStartedAt.t
    const durationMs =
      answerAt != null && answerAt > started ? answerAt - started : Date.now() - started
    // agentId omitted (attributed to the main agent): handleLLMEnd doesn't carry
    // the graph's lc_agent_name namespace the stream metadata does, so subagent
    // reasoning attribution is a follow-up. Single-agent turns (the common case)
    // are correct.
    const ev = thinkingDeltaEvent(randomUUID(), thinking, durationMs)
    this.sink.emit(this.conversationId, ev)
    appendEvent(this.conversationId, ev)
  }
}

// See the doc comment at this constant's one use site (in the messages-
// stream loop below) for why this must be a single stable value, not a
// per-chunk fresh uuid.
const FALLBACK_TOOL_MESSAGE_ID = 'tool-message:no-id'

// Consume the next unconsumed staged file for a write_file/edit_file tool
// call, in call order (the backend pushes staged files in execution order,
// which matches the order tool_result messages are seen in).
function nextStagedStats(
  ctx: DriveContext
): Extract<Event, { type: 'tool_result' }>['stats'] | undefined {
  const file = ctx.backend.stagedFiles[ctx.writeCursor.i]
  if (!file) return undefined
  ctx.writeCursor.i += 1
  return {
    path: ctx.projectPath ? relative(ctx.projectPath, file.path) || file.path : file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions
  }
}

function textOf(content: ToolMessageChunk['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : 'text' in part && typeof part.text === 'string'
            ? part.text
            : ''
      )
      .join('')
  }
  return String(content)
}

// One streamed invocation of the graph: either the initial user turn, or a
// resume-with-Command after an approval decision. Returns whether execution
// paused at a new interrupt (risk 4) so the caller can park it, or ran to
// completion so the caller can close out the turn (file_diff/turn_meta/done).
async function drive(
  agent: ReturnType<typeof createDeepAgent>,
  input: unknown,
  ctx: DriveContext
): Promise<DriveResult> {
  // Text/reasoning accumulators are split per producing agent (keyed by
  // agentIdOf's result, 'main' standing in for undefined/main) so
  // a subagent's answer/thinking text never gets appended into the main
  // agent's accumulating strings -- each agent gets its own upsert-by-id
  // Event stream (bridge.ts's textDeltaEvent/thinkingDeltaEvent take an
  // optional agentId, tagging every delta so the renderer's AgentAttributed
  // wrapper (WorkedGroup.tsx) can render a distinct pill per subagent).
  interface AgentTextState {
    answerId: string
    answer: string
    thinkId: string
    think: string
    thinkStartedAt: number
    thinkEndedAt: number
  }
  const textStates = new Map<string, AgentTextState>()
  const stateFor = (key: string): AgentTextState => {
    let s = textStates.get(key)
    if (!s) {
      s = {
        answerId: randomUUID(),
        answer: '',
        thinkId: '',
        think: '',
        thinkStartedAt: 0,
        thinkEndedAt: 0
      }
      textStates.set(key, s)
    }
    return s
  }

  const aiById = new Map<string, AIMessageChunk>()
  const aiOrder: string[] = []
  const aiAgentById = new Map<string, string | undefined>()
  const toolMsgById = new Map<string, ToolMessageChunk>()
  const toolAgentById = new Map<string, string | undefined>()
  // Live tool surfacing: the post-loop below is authoritative for persistence,
  // but a build task is almost all tool calls and little prose, so waiting for
  // it means the user stares at "Working…" with nothing happening. These let the
  // stream loop emit each tool_call/tool_result the moment its result starts
  // arriving (emit-only), while the post-loop re-emits + persists the same rows
  // by the SAME ids (renderer upserts -> no duplication). `liveAnnounced` guards
  // the one-time tool_call emit; `resultIdByTc` is the stable tool_result event
  // id shared between the live emit and the post-loop.
  const liveAnnounced = new Set<string>()
  const resultIdByTc = new Map<string, string>()
  const findToolCallInfo = (
    tcId: string
  ): { name?: string; args?: unknown; agentId?: string } | undefined => {
    for (const [mId, msg] of aiById) {
      for (const tc of msg.tool_calls ?? []) {
        if (tc.id === tcId) return { name: tc.name, args: tc.args, agentId: aiAgentById.get(mId) }
      }
    }
    return undefined
  }

  // subgraphs:true (per the verified API notes) exposes the subagent's
  // nested stream. Each yielded item is [namespace, [chunk, metadata]];
  // agentIdOf(metadata) (module scope, above) reads metadata.lc_agent_name
  // -- the deep agent's `task` tool tags every subagent chunk with the
  // subagent's name there, while the main graph's "model_request" node has
  // none -- so the main agent stays unattributed and never mislabelled.
  const stream = await agent.stream(input, {
    streamMode: 'messages',
    subgraphs: true,
    signal: ctx.signal,
    configurable: { thread_id: ctx.conversationId },
    // Reasoning arrives via this callback's handleLLMEnd, not the token stream
    // (see ReasoningBridgeHandler's doc comment for why).
    callbacks: [
      new ReasoningBridgeHandler(
        ctx.conversationId,
        ctx.sink,
        ctx.answerStartedAt,
        ctx.bridgedToolCalls,
        ctx.bridgedAnswerText,
        ctx.turnUsage
      )
    ]
  })

  for await (const item of stream) {
    const [, [chunk, metadata]] = item as MessagesStreamChunk
    const agentId = agentIdOf(metadata)
    const key = agentId ?? 'main'
    if (isToolMessageChunk(chunk)) {
      // ToolMessageChunk is always tagged with tool_call_id in practice: it's
      // how LangGraph's tool-executing node pairs a result back to the AI
      // message's tool_calls[].id (the `.id` fallback covers producers that
      // only set the chunk's own message id). If a chunk somehow arrives with
      // neither, DO NOT mint a fresh uuid per chunk here -- concat-by-id
      // above merges fragments of the SAME message keyed on this id, so a
      // fresh id per chunk would put every fragment in its own bucket and
      // silently drop the merge instead of just losing attribution. Fall
      // back to one shared, stable id so same-turn fragments still concat.
      const id = chunk.tool_call_id || chunk.id || FALLBACK_TOOL_MESSAGE_ID
      const prev = toolMsgById.get(id)
      const merged = prev ? (prev.concat(chunk) as ToolMessageChunk) : chunk
      toolMsgById.set(id, merged)
      if (!toolAgentById.has(id)) toolAgentById.set(id, agentId)

      // Surface this step LIVE. A result arriving means its tool_call is complete
      // in aiById (the AI message streamed before the tool ran), so we can emit
      // the tool_call once, then the tool_result on every chunk (streaming its
      // output). Emit-only: the post-loop persists the authoritative rows by the
      // same ids. Stats (write/edit line counts) are left to the post-loop so the
      // writeCursor advances exactly once. A pending run_command (awaiting
      // approval) never produces a result chunk, so it never enters here -- the
      // post-loop still owns the interrupt path.
      if (chunk.tool_call_id) {
        const tcId = chunk.tool_call_id
        const info = findToolCallInfo(tcId)
        if (info) {
          let localId = ctx.callIdMap.get(tcId)
          if (!localId) {
            localId = randomUUID()
            ctx.callIdMap.set(tcId, localId)
          }
          if (!liveAnnounced.has(tcId) && !ctx.alreadyAnnounced.has(localId)) {
            liveAnnounced.add(tcId)
            ctx.sink.emit(ctx.conversationId, {
              type: 'tool_call',
              id: localId,
              tool: (info.name as ToolName) ?? 'run_command',
              input: info.args,
              approvalState: 'auto',
              agentId: info.agentId
            })
          }
          let resultId = resultIdByTc.get(tcId)
          if (!resultId) {
            resultId = randomUUID()
            resultIdByTc.set(tcId, resultId)
          }
          const out = textOf(merged.content)
          const truncated = out.length > 50000
          ctx.sink.emit(ctx.conversationId, {
            type: 'tool_result',
            id: resultId,
            callId: localId,
            output: truncated ? out.slice(0, 50000) + '\n… output truncated' : out,
            durationMs: 0,
            truncated,
            agentId: agentId ?? info.agentId
          })
        }
      }
      continue
    }
    const aiChunk = chunk as AIMessageChunk
    const s = stateFor(key)
    if (process.env['BEARCODE_DEBUG_BLOCKS']) {
      const blocks = aiChunk.contentBlocks ?? []
      for (const b of blocks) {
        if (b.type === 'text') continue
        console.log(
          `[blocks] key=${key} type=${b.type} reasoningLen=${reasoningTextOf(b).length} raw=${JSON.stringify(b).slice(0, 160)}`
        )
      }
    }
    for (const block of aiChunk.contentBlocks ?? []) {
      const reasoning = reasoningTextOf(block)
      if (reasoning) {
        if (!s.thinkId) {
          s.thinkId = randomUUID()
          s.thinkStartedAt = Date.now()
        }
        s.think += reasoning
        ctx.sink.emit(
          ctx.conversationId,
          thinkingDeltaEvent(s.thinkId, s.think, Date.now() - s.thinkStartedAt, agentId)
        )
      } else if (block.type === 'text' && block.text) {
        if (s.thinkId && !s.thinkEndedAt) s.thinkEndedAt = Date.now()
        // Mark when the main agent's answer began, so the reasoning handler can
        // time "Thought for Ns" as the pre-answer gap. Main agent only (key ===
        // 'main'), so a subagent's text can't skew the main thinking timer.
        if (key === 'main' && ctx.answerStartedAt.t === null) ctx.answerStartedAt.t = Date.now()
        s.answer += block.text
        ctx.sink.emit(ctx.conversationId, textDeltaEvent(s.answerId, s.answer, agentId))
      }
    }
    const msgId = aiChunk.id ?? `${key}:__current__`
    const prevAi = aiById.get(msgId)
    if (!prevAi) {
      aiOrder.push(msgId)
      aiAgentById.set(msgId, agentId)
    }
    aiById.set(msgId, prevAi ? (prevAi.concat(aiChunk) as AIMessageChunk) : aiChunk)
  }

  // Persist merged blocks (same pattern as legacy run.ts: deltas stream live,
  // only the closed, merged block is written to the events table).
  for (const [key, s] of textStates) {
    const agentId = key === 'main' ? undefined : key
    if (s.thinkId && s.think) {
      appendEvent(
        ctx.conversationId,
        thinkingDeltaEvent(
          s.thinkId,
          s.think,
          (s.thinkEndedAt || Date.now()) - s.thinkStartedAt,
          agentId
        )
      )
    }
    if (s.answer) {
      appendEvent(ctx.conversationId, textDeltaEvent(s.answerId, s.answer, agentId))
      // Only the main agent's answer feeds title generation (subagent output
      // is internal), matching legacy run.ts which titles from the primary
      // answer. Accumulate across segments so a paused/resumed turn's title
      // sees the whole answer, not just the pre-pause fragment.
      if (key === 'main') ctx.answerAccum.text += s.answer
    }
  }

  // Emit tool_call/tool_result Events for every tool call this invocation's AI
  // message(s) issued, in order. processToolCall handles one COMPLETED call
  // (result present); it returns false for a no-result candidate so the caller
  // collects it for the batch pending-interrupt pairing below, or true once
  // the call needs no further handling.
  const processToolCall = async (
    tc: { id?: string; name?: string; args?: unknown },
    msgAgentId: string | undefined
  ): Promise<boolean> => {
    if (!tc.id) return true
    // Mint (or recall) the local id for this provider tool-call id up front,
    // before checking alreadyAnnounced -- see callIdMap's doc comment on
    // DriveContext. Recall matters across the pause/resume split: the same tc.id
    // is seen again after resume, and must map to the SAME local id that was
    // used for the pre-pause tool_call emit.
    let localId = ctx.callIdMap.get(tc.id)
    if (!localId) {
      localId = randomUUID()
      ctx.callIdMap.set(tc.id, localId)
    }
    const toolResult = toolMsgById.get(tc.id)
    if (!toolResult) return false
    // This call has completed: drop it from the bridged fallback so a later
    // drive() segment (approval resume, empty-final nudge) never re-iterates
    // it as a stale no-result candidate that could misclaim a NEW pending
    // interrupt. The still-pending call is deliberately NOT pruned -- it must
    // survive the pause/resume split (see bridgedToolCalls' doc comment).
    // Safe here: the caller iterates a snapshot of the Map, not the Map itself.
    ctx.bridgedToolCalls.delete(tc.id)
    // Prefer the agentId the tool_result chunk itself was namespaced under
    // (toolAgentById); fall back to the AI message's agentId if the result
    // somehow wasn't observed with a namespace (shouldn't happen, but keeps
    // attribution best-effort rather than silently dropping it).
    const resultAgentId = toolAgentById.get(tc.id) ?? msgAgentId
    if (!ctx.alreadyAnnounced.has(localId)) {
      emitAndPersist(ctx.conversationId, ctx.sink, {
        type: 'tool_call',
        id: localId,
        tool: (tc.name as ToolName) ?? 'run_command',
        input: tc.args,
        approvalState: 'auto',
        agentId: msgAgentId
      })
    }
    const output = textOf(toolResult.content)
    const stats =
      tc.name === 'write_file' || tc.name === 'edit_file' ? nextStagedStats(ctx) : undefined
    const truncated = output.length > 50000
    // Reuse the id the live emit used (if any) so this authoritative row -- now
    // carrying stats -- UPSERTS over the live one in the renderer instead of
    // appearing as a second result.
    emitAndPersist(ctx.conversationId, ctx.sink, {
      type: 'tool_result',
      id: resultIdByTc.get(tc.id) ?? randomUUID(),
      callId: localId,
      output: truncated ? output.slice(0, 50000) + '\n… output truncated' : output,
      durationMs: 0,
      truncated,
      stats,
      agentId: resultAgentId
    })
    return true
  }

  // Collect this segment's candidates in order: first the tool calls the
  // stream surfaced (most providers), recording their ids so the fallback
  // doesn't list the same call twice; then the fallback -- tool calls Deep
  // Agents stripped from the stream (Gemini bundles them into dropped
  // thought-bearing chunks) but that handleLLMEnd recorded on
  // ctx.bridgedToolCalls. Fallback calls are attributed to the main agent --
  // handleLLMEnd carries no lc_agent_name namespace, the same caveat as the
  // reasoning bridge. Pause/resume dedup is handled inside processToolCall
  // (callIdMap recall + the alreadyAnnounced guard) for both kinds.
  const processedTcIds = new Set<string>()
  const candidates: Array<{
    tc: { id?: string; name?: string; args?: unknown }
    msgAgentId: string | undefined
  }> = []
  for (const msgId of aiOrder) {
    const aiMsg = aiById.get(msgId)
    const msgAgentId = aiAgentById.get(msgId)
    for (const tc of aiMsg?.tool_calls ?? []) {
      if (tc.id) processedTcIds.add(tc.id)
      candidates.push({ tc, msgAgentId })
    }
  }
  for (const tc of ctx.bridgedToolCalls.values()) {
    if (processedTcIds.has(tc.id)) continue
    candidates.push({ tc, msgAgentId: undefined })
  }
  // Completed calls first (see orderCompletedCallsFirst's doc comment): a
  // resumed command's result -- reachable only via the bridged fallback, since
  // its AI message is never re-streamed -- must be persisted before a newly
  // paused segment returns. Chronologically sound too: a call with a result
  // finished before any pause was raised. No-result candidates are collected
  // (in order) for the pending-interrupt pairing below.
  const unresolved: Array<{
    tc: { id?: string; name?: string; args?: unknown }
    msgAgentId: string | undefined
  }> = []
  for (const { tc, msgAgentId } of orderCompletedCallsFirst(candidates, (id) =>
    toolMsgById.has(id)
  )) {
    if (!(await processToolCall(tc, msgAgentId))) unresolved.push({ tc, msgAgentId })
  }

  // No-result candidates mean the graph may have paused on approval-gated
  // tools (run_command, and Bb3's gated write_file/edit_file). Fetch the
  // checkpointed interrupts ONCE (all parallel tool calls of a superstep
  // interrupt independently -- one Send/PUSH task each) and pair every
  // interrupt to its candidate. A no-result candidate with no
  // interrupt is skipped silently, exactly as before: it is either a stale
  // bridged entry from a prior segment or a tool still genuinely running.
  if (unresolved.length > 0) {
    const { interrupts } = await findPendingInterrupts(agent, ctx.conversationId)
    if (interrupts.length > 0) {
      const agentIdByTcId = new Map<string, string | undefined>()
      for (const u of unresolved) {
        if (u.tc.id !== undefined) agentIdByTcId.set(u.tc.id, u.msgAgentId)
      }
      const pendingItems: PendingItem[] = []
      for (const pairing of pairInterruptsToCalls(
        interrupts,
        unresolved.map((u) => u.tc)
      )) {
        let item: PendingItem
        let agentId: string | undefined
        if (pairing.call) {
          // Mint-or-recall via callIdMap, same as processToolCall: the resumed
          // segment's tool_result must pair with this pending card's event id.
          let localId = ctx.callIdMap.get(pairing.call.id)
          if (!localId) {
            localId = randomUUID()
            ctx.callIdMap.set(pairing.call.id, localId)
          }
          // item.planReview is set EXCLUSIVELY from the checkpointed interrupt
          // payload's kind (planReviewArtifactIdOf), never from renderer
          // input: it is what buildResumeMap's kind branch keys on.
          const planArtifactId = planReviewArtifactIdOf(pairing.value)
          item = {
            callId: localId,
            interruptId: pairing.interruptId,
            tool: (pairing.call.name as ToolName) ?? 'run_command',
            // Enriched for edit interrupts only (reviewer finding 2): the
            // card's input must show the resolved target in the common live
            // paired case too. Pairing above already matched on the RAW
            // streamed args; only the emitted event/parked item changes.
            // Plan interrupts get the payload's artifactId merged in the same
            // way, for card <-> pane pairing.
            input: pairedApprovalInput(pairing.value, pairing.call.args),
            toolCallId: pairing.call.id,
            ...(planArtifactId !== undefined ? { planReview: { artifactId: planArtifactId } } : {})
          }
          agentId = agentIdByTcId.get(pairing.call.id)
        } else {
          // The interrupt paired to no candidate (e.g. a stripped call the
          // bridge also missed): synthesize the card from the interrupt
          // payload so the approval still surfaces instead of hanging
          // (synthesizedApprovalCard branches run_command vs edit_file vs
          // plan_review and keeps the pin identity intact).
          const planArtifactId = planReviewArtifactIdOf(pairing.value)
          item = {
            callId: randomUUID(),
            interruptId: pairing.interruptId,
            ...synthesizedApprovalCard(pairing.value),
            ...(planArtifactId !== undefined ? { planReview: { artifactId: planArtifactId } } : {})
          }
        }
        // Not persisted here (matching legacy run.ts): only the final
        // approvalState ('approved'/'denied', written once resolved, see
        // resolveInterrupt below) lands in the events table. Persisting this
        // 'pending' row too would collide on the same event id.
        ctx.sink.emit(ctx.conversationId, {
          type: 'tool_call',
          id: item.callId,
          tool: item.tool,
          input: item.input,
          approvalState: 'pending',
          agentId
        })
        pendingItems.push(item)
      }
      ctx.sink.setState(ctx.conversationId, 'awaiting-approval')
      return { paused: true, pending: pendingItems }
    }
  }

  // Bridge the final answer if the stream dropped it (Bug A cause 2): when
  // handleLLMEnd captured answer text that never made it into the streamed
  // accumulator, emit + persist it now, after the tool rows (so the recovered
  // assistant_text lands below the tool_results it describes). For providers
  // whose stream carries text normally, the streamed answer already contains
  // the bridged text verbatim and shouldEmitBridgedText makes this a no-op.
  const bridged = ctx.bridgedAnswerText.text
  if (shouldEmitBridgedText(bridged, ctx.answerAccum.text)) {
    emitAndPersist(ctx.conversationId, ctx.sink, textDeltaEvent(randomUUID(), bridged))
    ctx.answerAccum.text += bridged
  }

  return { paused: false }
}

// One diff-backed backend + one parked approval SET per in-flight turn: all
// the approval cards a paused segment surfaced, keyed by callId (the pending
// tool_call event id each Approve/Deny click carries). Collect-then-resume:
// decisions are recorded per card and the graph is re-driven with ONE keyed
// resume only once every card is answered, so no command executes while the
// user is still deciding about its siblings.
interface PendingApprovalSet extends DriveContext {
  agent: ReturnType<typeof createDeepAgent>
  items: Map<string, ApprovalItem>
}
const pendingApprovals = new Map<string, PendingApprovalSet>()

// A run that pauses on approval returns early from startRunOrchestrator
// (src/main/orchestrator/index.ts) with its AbortController kept live in that
// module's `aborts` map, because Stop and the approval lookup still need it.
// When the *resumed* run later settles terminally (here in
// continueAfterApproval, not back in startRunOrchestrator), index.ts has no
// other signal to clear that entry -- so it registers this callback to prune
// its map. Set via setOnResumeSettled; a plain module-level hook rather than a
// direct import keeps index.ts -> graph.ts the only import direction.
let onResumeSettled: ((conversationId: string) => void) | undefined
export function setOnResumeSettled(fn: (conversationId: string) => void): void {
  onResumeSettled = fn
}

// Called from src/main/orchestrator/index.ts's resolveApprovalOrchestrator
// (IPC bridge for bearcode:tools:approve). Records ONE card's decision:
// flips that card's tool_call to approved/denied immediately (emit-only,
// under the same event id), and only when EVERY card in the set has a
// decision persists all the terminal rows and dispatches the single keyed
// resume (continueAfterApproval). Persistence deliberately waits for the
// dispatch (resolvedToolCallEvents' doc comment): nothing executes until the
// batch resume, so a decision row written earlier would survive an app quit
// in the collect window as a false record. Returns false if the callId
// matches nothing pending here (a stale click, an already-answered card, or
// another conversation's card -- the orchestrator scans conversations with
// this).
export function resolveInterrupt(
  conversationId: string,
  callId: string,
  approved: boolean
): boolean {
  const pending = pendingApprovals.get(conversationId)
  if (!pending) return false
  const item = pending.items.get(callId)
  // Unknown callId, or a double-click on an already-answered card: no-op.
  // Every sibling card needs its own click -- a saved allow rule never
  // auto-approves one here. (It can flip a sibling's rules re-evaluation on
  // the replay, which is why continueAfterApproval pins every Denied card at
  // the execution layer before dispatching; see tools.ts deniedReplayPins.)
  if (!item || item.decision !== undefined) return false
  // Kind cross-guard (SECURITY): the boolean command/edit channel can never
  // resolve a plan review -- its { approved } shape is not a plan resolution,
  // and plan approval must never share a wire with command approval. The
  // mirror guard lives in resolvePlanInterrupt. Defense in depth: even
  // WITHOUT this guard, a bare `decision` recorded on a plan item could never
  // dispatch into submit_plan's PlanReviewResolution cast -- allDecided
  // treats a plan item as decided only by planReview.resolution, so the
  // batch would simply never dispatch -- but reject explicitly so the wire
  // contract is visible and the card is not half-flipped.
  if (item.planReview) return false
  // Defense in depth: cancelRunOrchestrator (src/main/orchestrator/index.ts)
  // is the primary fix -- it deletes this conversation's pendingApprovals
  // entry (via cancelPendingApproval below) the instant Stop is clicked, so
  // a later Approve/Deny normally finds nothing here at all. But if a Stop
  // and an in-flight Approve/Deny IPC call ever race, ctx.signal.aborted is
  // the authoritative "this run is over" signal (same field failTurn below
  // checks), so refuse to record a decision on a cancelled run even if its
  // pending-approval entry is somehow still present.
  if (pending.signal.aborted) {
    pendingApprovals.delete(conversationId)
    return false
  }
  item.decision = approved
  return finalizeDecision(pending, callId, item, approved ? 'approved' : 'denied')
}

// Shared tail of resolveInterrupt/resolvePlanInterrupt: emit the terminal
// card (emit-only; persistence waits for the dispatch, see
// resolvedToolCallEvents' doc comment), and once EVERY card is decided,
// persist the batch and dispatch the single keyed resume.
// The emit-only card flip collapses the card in the UI right away, but the
// row is NOT persisted yet -- the batch may never dispatch (quit/crash in the
// collect window), and the DB must not record a decision for a call that
// never replayed. alreadyAnnounced is stamped before any re-drive so the
// resumed segment doesn't double-emit this card. At dispatch,
// appendOrReplaceEvent (not appendEvent): each resolved tool_call reuses its
// pending card's event id -- in the live flow the pending row was never
// persisted so this inserts; in the crash-resume flow rehydratePausedRun
// persisted the pending row, so this replaces it in place rather than
// colliding on events.id.
function finalizeDecision(
  pending: PendingApprovalSet,
  callId: string,
  item: ApprovalItem,
  terminal: 'approved' | 'denied'
): boolean {
  pending.sink.emit(pending.conversationId, {
    type: 'tool_call',
    id: callId,
    tool: item.tool,
    input: item.input,
    approvalState: terminal
  })
  pending.alreadyAnnounced.add(callId)
  // Sibling cards still undecided: stay parked ('awaiting-approval' stands,
  // the composer stays locked) until every card is answered.
  if (!allDecided(pending.items)) return true
  pendingApprovals.delete(pending.conversationId)
  for (const event of resolvedToolCallEvents(pending.items)) {
    appendOrReplaceEvent(pending.conversationId, event)
  }
  pending.sink.setState(pending.conversationId, 'running')
  void continueAfterApproval(pending)
  return true
}

// Proceed of a plan_review flips the conversation out of read-only plan mode so
// implementation can start (mode-picker design §5). CONDITIONAL: only when the
// conversation is STILL in `plan` at Proceed time. If the user manually switched
// during the pause (e.g. to `auto`), their explicit choice is left untouched and
// this returns null. v1 always targets the default `accept-edits`; it never
// escalates past accept-edits and never overwrites a non-plan mode.
export function planProceedModeFlip(current: PermissionMode | undefined): PermissionMode | null {
  return current === 'plan' ? 'accept-edits' : null
}

// Resolves ONE plan-review card (design 3.5/3.6), called from
// resolvePlanReviewOrchestrator (IPC bearcode:artifacts:resolve-plan-review).
// The resolution is composed MAIN-side from durable state: the artifact's
// still-unsent comments (drafted in the pane, persisted since Ba2 Task 1)
// plus the optional free message, rendered as markdown quotes
// (renderPlanFeedback). Proceed delivers the rendered comments as steering
// context AND resumes { proceed: true }; Review resumes { proceed: false,
// feedback } and REQUIRES at least one comment or a message (the UI enforces
// it too, but the main process is authoritative). The return DISCRIMINANT
// exists for the renderer's failure copy: 'stale' (unknown/answered/aborted/
// non-plan card) vs 'needs-substance' vs 'resolved'.
// sent_at is stamped the moment the comments are frozen into the resolution.
// DECIDED + ACCEPTED crash window: a crash between this sent_at stamp and the
// resumed graph's checkpoint commit loses the delivery (the comments read
// "sent" but the model never saw them). Reordering cannot close it -- the
// stamp and checkpoints.db share no transaction wherever it happens (the same
// accepted class as Ba1's replay windows) -- and stamping at decision time
// keeps composition and stamping in one place; the recovery is mundane (the
// re-parked card is answered again; the user re-types or Reviews with a
// message).
// SECURITY: this touches only the parked item, the events table, and
// artifact_comments.sent_at -- never the permission engine, never the
// workspace; and the kind cross-guard below means this channel can never
// resolve a command/edit card.
export function resolvePlanInterrupt(
  conversationId: string,
  callId: string,
  decision: { proceed: boolean; message?: string }
): PlanReviewResolveResult {
  const pending = pendingApprovals.get(conversationId)
  if (!pending) return 'stale'
  const item = pending.items.get(callId)
  if (!item?.planReview || item.planReview.resolution !== undefined) return 'stale'
  if (pending.signal.aborted) {
    pendingApprovals.delete(conversationId)
    return 'stale'
  }
  const comments = listArtifactComments(item.planReview.artifactId).filter((c) => c.sentAt === null)
  const message = decision.message?.trim() ?? ''
  if (!decision.proceed && comments.length === 0 && message === '') return 'needs-substance'
  const rendered = renderPlanFeedback(comments, message)
  item.planReview.resolution = decision.proceed
    ? rendered !== ''
      ? { proceed: true, comments: rendered }
      : { proceed: true }
    : { proceed: false, feedback: rendered }
  if (comments.length > 0) markArtifactCommentsSent(item.planReview.artifactId, Date.now())
  // Proceed relaxes plan-mode read-only so the resumed run can implement
  // (design §5). Read the mode LIVE (a manual switch during the pause wins) and
  // only flip when still in plan. This is the one net-new state mutation on the
  // resume path; the Review path leaves the mode as `plan`.
  if (decision.proceed) {
    const next = planProceedModeFlip(getConversationMeta(conversationId)?.permissionMode)
    if (next) setPermissionMode(conversationId, next)
  }
  finalizeDecision(pending, callId, item, decision.proceed ? 'approved' : 'denied')
  return 'resolved'
}

// TEST-ONLY SEAM for graph.test.ts: pendingApprovals is module-private and
// the real park paths (settleTurn/rehydratePausedRun) need a live graph, so
// the resolution-channel cross-guard tests seed a synthetic parked set here.
// The guards under test never touch the agent or the DriveContext fields, so
// a minimal stub is honest. Never call from production code.
export function __parkForTest(
  conversationId: string,
  items: Map<string, ApprovalItem>,
  sink: RunSink,
  signal: AbortSignal
): void {
  pendingApprovals.set(conversationId, {
    conversationId,
    sink,
    signal,
    items,
    alreadyAnnounced: new Set()
  } as unknown as PendingApprovalSet)
}

// Called from cancelRunOrchestrator (src/main/orchestrator/index.ts) when
// Stop is clicked while a run is parked awaiting command approval (risk 4).
// Legacy run.ts handles this by having the abort signal resolve the pending
// JS approval promise as denied (see its `controller.signal.addEventListener`
// near line 311); there is no equivalent live promise here -- interrupt()
// suspends the graph itself and returns control up through drive() to
// runGraph/continueAfterApproval, which parks the resumable state in
// pendingApprovals and returns. So the pendingApprovals entry IS the pending
// decision: deleting it here is what makes cancellation deterministic --
// resolveInterrupt above can then never find it again, so a stale Approve
// click is a no-op and the run_command tool's interrupt() is never resumed
// with an approval, which means the shell command can never execute.
// Emits the same 'denied' tool_call shape a real Deny click would for EVERY
// card in the set -- including cards already answered 'approved': the batch
// resume never dispatched, so nothing executed and denied is the truthful
// terminal state (deniedToolCallEvents' doc comment). appendOrReplaceEvent
// because an answered card already persisted its resolved row (and a
// rehydrated card its pending row) under the same event id. Returns the sink
// so the caller (which only tracks AbortControllers, not sinks, per
// conversation) can finish tearing the run down to a terminal 'cancelled'
// state.
export function cancelPendingApproval(conversationId: string): RunSink | undefined {
  const pending = pendingApprovals.get(conversationId)
  if (!pending) return undefined
  pendingApprovals.delete(conversationId)
  // Stop during a plan pause: NO resume dispatches (the same no-dispatch that
  // makes command cancellation deterministic); the artifact row is untouched
  // and stays pending-review -- stopping is not plan rejection (design 3.5;
  // the { proceed:false, feedback:'The user stopped the run.' } mapping lives
  // as buildResumeMap's plan fail-safe). Clear the design-5 gate so a later
  // turn can submit again.
  clearPlanReviewPending(conversationId)
  for (const event of deniedToolCallEvents(pending.items)) {
    pending.sink.emit(pending.conversationId, event)
    appendOrReplaceEvent(pending.conversationId, event)
  }
  return pending.sink
}

// Silent teardown for conversation delete/clear: drop any parked approval
// without emitting a denied tool_call or touching the DB, since the
// conversation itself is being removed. (cancelPendingApproval, by contrast,
// is the Stop path and drives the conversation to a terminal 'cancelled'
// state the renderer still shows.)
export function forgetPendingApproval(conversationId: string): void {
  pendingApprovals.delete(conversationId)
  clearPlanReviewPending(conversationId)
}

export function clearAllPendingApprovals(): void {
  pendingApprovals.clear()
  clearAllPlanReviewPending()
}

// Model-facing only: lives in the thread's checkpointed graph state, never in
// the events table (see settleTurn below).
const EMPTY_FINAL_NUDGE =
  "You returned an empty response. Answer the user's last request now, " +
  'using the tool results above.'

// Shared un-paused completion for runGraph and continueAfterApproval, factored
// so the two sites can't drift. Parks a paused result in pendingApprovals and
// returns true (caller must NOT settle the turn); otherwise runs the
// empty-final recovery (Bug A cause 1), closes out the turn, and returns
// false. The recovery: when the turn ran at least one tool but accumulated no
// answer text, re-drive ONCE on the same thread/checkpointer with a brief
// nudge. The nudge is graph-state only -- deliberately NOT persisted as a
// user_message event, so it is invisible in the UI but part of the thread's
// checkpointed history (visible to the model in later turns). If the turn is
// still empty after the nudge, a persisted error event tells the user instead
// of silently stamping done.
async function settleTurn(
  agent: ReturnType<typeof createDeepAgent>,
  result: DriveResult,
  ctx: DriveContext
): Promise<boolean> {
  let final = result
  if (
    !final.paused &&
    shouldRetryEmptyFinal(ctx.callIdMap.size, ctx.answerAccum.text, ctx.emptyFinalRetried.done)
  ) {
    ctx.emptyFinalRetried.done = true
    final = await drive(agent, { messages: [{ role: 'user', content: EMPTY_FINAL_NUDGE }] }, ctx)
  }
  if (final.paused && final.pending && final.pending.length > 0) {
    pendingApprovals.set(ctx.conversationId, {
      ...ctx,
      agent,
      items: new Map(
        final.pending.map((p) => [
          p.callId,
          {
            interruptId: p.interruptId,
            tool: p.tool,
            input: p.input,
            toolCallId: p.toolCallId,
            ...(p.planReview ? { planReview: { artifactId: p.planReview.artifactId } } : {})
          }
        ])
      )
    })
    return true
  }
  if (ctx.callIdMap.size > 0 && ctx.answerAccum.text === '') {
    // Tools ran but even the nudge retry produced no answer: surface why the
    // turn has no text (same recoverable error shape failTurn emits).
    emitAndPersist(ctx.conversationId, ctx.sink, {
      type: 'error',
      id: randomUUID(),
      message: 'The model returned an empty response after running commands. Try asking again.',
      recoverable: true
    })
  }
  await closeOutTurn(agent, ctx)
  return false
}

// The single batch dispatch once resolveInterrupt has a decision for every
// card (the per-card resolved emit/persist already happened there). The keyed
// resume map ({ [interruptId]: { approved } }) resolves each parallel task's
// interrupt independently -- LangGraph matches map keys against each task's
// namespace hash -- and every value stays a truthy { approved } object (see
// tools.ts's interrupt() call for why a falsy resume is rejected).
async function continueAfterApproval(pending: PendingApprovalSet): Promise<void> {
  const { agent, items, ...ctx } = pending
  // Execution-layer deny enforcement: each interrupted task replays its tool
  // from the top on this keyed resume, re-running the rules engine BEFORE the
  // interrupt() that would return { approved: false } -- so a rule saved from
  // a sibling card's "always allow" (or a mode flip to 'auto') during the
  // collect window would otherwise skip the interrupt and execute a command
  // the user explicitly denied. Pin every denied card so the replayed tool
  // honors the recorded decision first (tools.ts deniedReplayPins). The pins
  // are consumed during this drive() call (interrupted tasks replay before
  // anything else); clear any leftovers on every exit path, including the
  // re-pause early return.
  pinDeniedReplays(ctx.conversationId, deniedReplayPinsOf(items))
  try {
    const result = await drive(agent, new Command({ resume: buildResumeMap(items) }), ctx)
    if (await settleTurn(agent, result, ctx)) return
  } catch (err) {
    await failTurn(ctx, err)
  } finally {
    clearDeniedReplayPins(ctx.conversationId)
  }
  // Reached only on a terminal settle (closeOutTurn or failTurn), never on the
  // re-pause early return above -- so index.ts clears the AbortController it
  // kept alive across the pause exactly once the resumed run is truly over.
  onResumeSettled?.(ctx.conversationId)
}

async function failTurn(ctx: DriveContext, err: unknown): Promise<void> {
  // A segment that dies mid-pause must not leave the design-5 plan-review
  // gate held (tools.ts tryEnterPlanReview).
  clearPlanReviewPending(ctx.conversationId)
  const cancelled = ctx.signal.aborted
  const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
  if (!cancelled)
    console.error(`[bearcode] orchestrator resume failed (${ctx.conversationId}):`, message)
  emitAndPersist(ctx.conversationId, ctx.sink, {
    type: 'error',
    id: randomUUID(),
    message,
    recoverable: true
  })
  ctx.sink.setState(ctx.conversationId, cancelled ? 'cancelled' : 'error')
}

// Build the deep agent + its DriveContext for a conversation. Shared by
// runGraph (a fresh turn) and rehydratePausedRun (crash-resume, A2) so the two
// can never drift in how the agent, checkpointer, backend, and tools are wired.
// A real SQLite-backed checkpointer (src/main/orchestrator/checkpointer.ts, its
// own `checkpoints.db`, separate from the `events` table) makes the graph's
// execution state survive a crash, not just the token stream (verified option
// name: planning/replatform-api-notes.md section (e)), AND lets raw `interrupt()`
// calls (risk 4, tools.ts) pause/resume this thread (section (d2)).
// The command-refusal marker (D2 Task 3, design 5.3/11): an unknown builtin,
// an unknown/erroring/colliding workflow, or a workflow that resolves past
// the cycle/inclusion/12k caps refuses the WHOLE turn before any model call
// -- returned as a plain data member instead of a thrown error so callers
// (runGraph, rehydratePausedRun) can each apply their own refusal handling
// (a visible error event vs. a plain "not resumable") rather than unwinding
// through a catch shared with unrelated failures.
type BuildResult =
  { agent: ReturnType<typeof createDeepAgent>; ctx: DriveContext } | { refusal: string }

// Persist @-mentioned Manual rule names into the conversation's active_rules
// (D3 design 4.2/7), unioned with whatever is already pinned. Called at the
// top of runGraph BEFORE buildAgentAndContext so this turn's getConversationMeta
// read already sees the freshly pinned rule (same-turn activation) AND the pin
// survives to later turns + crash-resume (which read meta.activeRules). A name
// that is not a real Manual rule is harmless: assembleRuleAdditions only
// renders names matching a loaded manual rule. Exported for tests.
export function persistRuleMentions(conversationId: string, mentions: MentionRef[]): void {
  const names = mentionedRuleNames(mentions)
  if (names.length === 0) return
  const meta = getConversationMeta(conversationId)
  const merged = mergeActiveRules(meta?.activeRules ?? [], names)
  setActiveRules(conversationId, merged)
}

function buildAgentAndContext(
  conversationId: string,
  modelRef: string,
  userText: string,
  command: CommandRef | null,
  sink: RunSink,
  signal: AbortSignal,
  mentions: MentionRef[] = []
): BuildResult {
  const { provider: providerId, modelId } = parseModelRef(modelRef)
  const meta = getConversationMeta(conversationId)
  const projectPath = meta?.projectPath ?? null
  // F3: in worktree mode, hand the backend the repoPath→worktreePath redirect
  // table. resolveWorktreeMappings verifies each worktree still exists on disk;
  // a resumed conversation whose worktree was deleted must fail loudly, never
  // silently write to the project tree.
  const worktreeMappings =
    meta?.environment === 'worktree' && meta.worktrees.length > 0
      ? meta.worktrees.map((w) => ({ repoPath: w.repoPath, worktreePath: w.worktreePath }))
      : []
  for (const m of worktreeMappings) {
    if (!existsSync(m.worktreePath)) {
      throw new Error(
        `Worktree missing for this conversation: ${m.worktreePath}. It may have been deleted or moved. Discard this conversation's worktrees and start a new one.`
      )
    }
  }
  const model = makeModel(modelRef, { effort: meta?.effort, thinking: meta?.thinking })
  const diffGroupId = randomUUID()
  const backend = projectPath
    ? new DiffFsBackend(conversationId, projectPath, diffGroupId, worktreeMappings)
    : undefined
  // createDeepAgent gets a FACTORY (resolved per builtin-tool invocation, so
  // the Bb3 edit gate sees each call's provider tool-call id) while ctx.backend
  // below keeps pointing at the ONE shared DiffFsBackend -- the staged-files
  // post-loop and closeOutTurn read its stagedFiles. The runtime cast is
  // needed because the published BackendFactory parameter type omits the
  // toolCall field the tool-time runtime actually carries (verified:
  // scratchpad bb3-edit-gating-probe.md section 2, probe B).
  const backendFactory = backend
    ? (runtime: unknown): GatedDiffFsBackend =>
        new GatedDiffFsBackend(
          backend,
          (runtime as { toolCall?: { id?: string } } | undefined)?.toolCall?.id,
          conversationId,
          projectPath as string
        )
    : undefined
  // .agents rules load once per turn, right here at agent build (design 3.2):
  // Always On rules, the conversation's pinned Manual rules, and glob rules
  // matched against files this conversation already touched. A broken .agents
  // dir (or any failure in the load/assemble path) never blocks a turn
  // (design 11): the catch drops the additions and the turn runs on the base
  // prompt alone.
  let ruleAdditions = ''
  let workflows: Workflow[] = []
  try {
    const content = loadAgentsContent(projectPath)
    workflows = content.workflows
    const touched = projectPath ? touchedFilesFor(conversationId) : []
    // buildTools only registers the activate_rule tool below when a project
    // is open (backendFactory is set); global rules still load with no
    // project open, so a 'model' activation rule must be filtered out here
    // or the prompt advertises a tool the model can't call this turn.
    const asm = assembleRuleAdditions({
      content: projectPath ? content : withoutModelRules(content),
      pinnedManualRules: meta?.activeRules ?? [],
      mentionPaths: mentionedFilePaths(mentions), // D3: file mentions feed glob-on-mention
      touchedFiles: touched
    })
    if (asm.systemAdditions.length > 0) ruleAdditions = '\n\n' + asm.systemAdditions.join('\n\n')
  } catch (err) {
    console.warn('[bearcode] .agents rules skipped:', err)
  }
  // Command additions (design 3.2 items 5/6, D2 Task 3) are assembled OUTSIDE
  // the rules try/catch above on purpose: a broken .agents dir degrades the
  // RULE additions and the turn still runs (design 11), but a broken COMMAND
  // (unknown builtin, unknown/erroring/colliding workflow, or a workflow past
  // the cycle/inclusion/12k caps) refuses the whole turn -- different
  // policies that must never share a catch. loadAgentsContent already ran
  // above for the rules; `workflows` rides that same call (possibly [] if it
  // threw), so this never does extra IO.
  const cmd = assembleCommandAdditions(command, workflows)
  if (cmd.error) return { refusal: cmd.error }
  const commandAdditions =
    cmd.systemAdditions.length > 0 ? '\n\n' + cmd.systemAdditions.join('\n\n') : ''
  // @ mention additions (D3 design 7): the Referenced-files block + a block
  // per referenced conversation (title + final assistant answer). Wrapped in
  // its own try/catch — a lookup failure degrades the additions, never the
  // turn (design 11), same policy as the rules block.
  let mentionAdditions = ''
  try {
    const mentionAsm = assembleUserMentions(mentions, {
      conversationSummary: (id) => {
        const cm = getConversationMeta(id)
        if (!cm) return null
        const events = getEvents(id)
        let finalAnswer: string | null = null
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i]
          if (e.type === 'assistant_text') {
            finalAnswer = e.text
            break
          }
        }
        return { title: cm.title ?? 'Untitled conversation', finalAnswer }
      }
    })
    if (mentionAsm.systemAdditions.length > 0) {
      mentionAdditions = '\n\n' + mentionAsm.systemAdditions.join('\n\n')
    }
  } catch (err) {
    console.warn('[bearcode] @ mention additions skipped:', err)
  }
  // Auto-compaction tuning (Task C3): replace deepagents' default
  // summarization middleware with one tuned to THIS model — trigger at ~85% of
  // the real context window, keep the recent half, summarize with a cheap fast
  // model. For providers we tune (everything but Ollama, whose model class
  // resolves to no harness profile) we exclude the default from the main
  // agent's stack and pass our renamed replacement so exactly one runs. Ollama
  // has no known window to tune against, so it keeps the default middleware.
  // Manual "Compact now" (one-shot): if the user requested it, force this one
  // turn's summarizer to fire on the next model call by consuming the flag here.
  const force = consumeForceCompact(conversationId)
  let summarizationMiddleware: ReturnType<typeof buildTunedSummarization>[] = []
  if (tunesSummarization(modelRef)) {
    excludeDefaultSummarization()
    summarizationMiddleware = [
      buildTunedSummarization(modelRef, backendFactory ?? defaultStateBackendFactory(), force)
    ]
  }
  const agent = createDeepAgent({
    model,
    middleware: summarizationMiddleware,
    // meta is null only for a conversation deleted mid-flight (the run is
    // doomed either way). The plan-mode frame (mode-picker design §5, phase 2)
    // is keyed on the conversation's live permission mode: assembled per-turn,
    // so switching into/out of plan mode takes effect on the next turn with no
    // extra machinery.
    systemPrompt:
      orchestratorSystemPrompt(projectPath, meta?.permissionMode === 'plan') +
      ruleAdditions +
      commandAdditions +
      mentionAdditions,
    checkpointer: getCheckpointer(),
    subagents: [RESEARCHER_SUBAGENT],
    ...(backendFactory
      ? {
          backend: backendFactory,
          tools: buildTools(projectPath as string, conversationId, sink, diffGroupId)
        }
      : {})
  })
  const ctx: DriveContext = {
    conversationId,
    sink,
    providerId,
    modelId,
    startedAt: Date.now(),
    userText,
    projectPath: projectPath ?? '',
    backend: backend ?? new DiffFsBackend(conversationId, '', diffGroupId),
    diffGroupId,
    signal,
    writeCursor: { i: 0 },
    alreadyAnnounced: new Set(),
    callIdMap: new Map(),
    answerAccum: { text: '' },
    answerStartedAt: { t: null },
    bridgedToolCalls: new Map(),
    bridgedAnswerText: { text: '' },
    emptyFinalRetried: { done: false },
    turnUsage: makeTurnUsage()
  }
  return { agent, ctx }
}

export async function runGraph(opts: {
  conversationId: string
  userText: string
  modelRef: string
  sink: RunSink
  signal: AbortSignal
  command?: CommandRef | null
  mentions?: MentionRef[]
  attachments?: AttachmentRef[]
}): Promise<{ paused: boolean }> {
  const {
    conversationId,
    userText,
    modelRef,
    sink,
    signal,
    command = null,
    mentions = [],
    attachments = []
  } = opts

  sink.setState(conversationId, 'running')
  // A stale gate slot from a stopped plan pause must never block this turn's
  // submissions; if the old interrupted task replays on this thread, it
  // re-enters its own artifactId slot (tools.ts tryEnterPlanReview).
  clearPlanReviewPending(conversationId)
  // Pin any @-mentioned Manual rules into active_rules BEFORE building the
  // agent, so this turn's meta read already includes them (see
  // persistRuleMentions).
  persistRuleMentions(conversationId, mentions)
  const userEvent: Event = {
    type: 'user_message',
    id: randomUUID(),
    text: userText,
    createdAt: Date.now(),
    ...(command ? { command } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  }
  sink.emit(conversationId, userEvent)
  appendEvent(conversationId, userEvent)

  // /compact (D2 builtin): force the summarizer to fold the backlog on THIS
  // turn. markForceCompact sets the one-shot flag that buildAgentAndContext
  // consumes below (consumeForceCompact) to build an aggressive
  // trigger+keep, so compaction fires on this model call — before the agent
  // acks — rather than lowering the trigger for some later turn.
  if (commandForcesCompact(command)) {
    markForceCompact(conversationId)
  }

  const built = buildAgentAndContext(
    conversationId,
    modelRef,
    userText,
    command,
    sink,
    signal,
    mentions
  )
  if ('refusal' in built) {
    // REFUSAL PATH (design 5.3/11, Global Constraints, review finding): the
    // user_message above is ALREADY persisted (transcript honesty), so this
    // must NOT re-append it. Mirrors failTurn's error-event shape
    // (graph.ts:1649-1656) inline: emit + persist the error, mark the run
    // 'error', and return { paused: false } -- never a bare return, which
    // would leave the run state 'running' forever (nothing else resets it on
    // a clean early return). No turn_meta: no model turn happened.
    emitAndPersist(conversationId, sink, {
      type: 'error',
      id: randomUUID(),
      message: built.refusal,
      recoverable: true
    })
    sink.setState(conversationId, 'error')
    return { paused: false }
  }
  const { agent, ctx } = built

  // Model-side guard for empty trailing text (design 5.2, review finding):
  // the persisted user_message above keeps text: '' plus the command (honest
  // transcript), but drive() must never receive an empty user message. This
  // also covers retryRun's edge (store.ts resends lastUser.text, which can be
  // '', dropping the command per Task 4 -- that resend gets 'Proceed.').
  // Bare /compact (no trailing prose): the forced summarizer runs inside this
  // turn's model call, so instead of a generic 'Proceed.' inject the honest
  // ack directive. It keys the reply off whether a summary is actually present
  // in context, so the acknowledgement is truthful whether or not there was
  // enough history to compact (see COMPACT_ACK_DIRECTIVE). Trailing prose after
  // /compact runs verbatim (compaction still attempted; flag set before build).
  const modelText =
    userText.trim() !== ''
      ? userText
      : command?.kind === 'builtin' && command.name === 'compact'
        ? COMPACT_ACK_DIRECTIVE
        : command?.kind === 'workflow'
          ? 'Run the workflow.'
          : 'Proceed.'

  try {
    const pdfNative = supportsNativePdf(parseModelRef(modelRef).provider)
    const content = buildUserMessageContent(
      modelText,
      attachments,
      (a) => readAttachmentBase64(conversationId, a.id),
      (a) => readAttachmentSidecar(conversationId, a.id),
      { pdfNative }
    )
    const result = await drive(agent, { messages: [{ role: 'user', content }] }, ctx)
    if (await settleTurn(agent, result, ctx)) return { paused: true }
  } catch (err) {
    await failTurn(ctx, err)
  }
  return { paused: false }
}

// The interrupt kinds the crash-resume path knows how to re-surface as
// approval cards: run_command (tools.ts), Bb3's edit_file (fsBackend.ts
// GatedDiffFsBackend), and Ba2's plan_review (tools.ts submit_plan).
// Exported for tests.
export function isRehydratableInterrupt(value: unknown): boolean {
  const kind = (value as { kind?: string } | null | undefined)?.kind
  return kind === 'run_command' || kind === 'edit_file' || kind === 'plan_review'
}

// Full crash-resume (A2). Called at boot for a dangling conversation: rebuilds
// the agent (same checkpointer + thread_id, so it reads the persisted execution
// state) and checks whether the run died parked at command- or edit-approval
// interrupts. If so, re-surfaces every approval card and re-parks the whole
// set in pendingApprovals so the existing resolveApprovalOrchestrator ->
// resolveInterrupt -> continueAfterApproval path resumes the graph from the
// checkpoint. Returns true if it re-parked pending approvals, false if there
// was nothing safely resumable (caller then degrades to 'cancelled').
// Security: this only re-shows the approvals; no command ever auto-runs and
// no write ever auto-lands -- the user must answer every card again.
export async function rehydratePausedRun(
  conversationId: string,
  modelRef: string,
  userText: string,
  command: CommandRef | null,
  sink: RunSink,
  signal: AbortSignal
): Promise<boolean> {
  const built = buildAgentAndContext(conversationId, modelRef, userText, command, sink, signal)
  // A refusal marker during rehydrate returns false (not resumable): it
  // cannot happen for a turn that already ran unless the workflow file
  // changed on disk since (design 5.3/11, review finding) -- degrading to
  // the existing not-resumable path (caller falls back to 'cancelled') is the
  // honest response, since the paused turn's original prompt can no longer
  // be faithfully rebuilt.
  if ('refusal' in built) return false
  const { agent, ctx } = built
  const { interrupts, messages } = await findPendingInterrupts(agent, conversationId)
  // No interrupt -> a mid-stream crash with no safe resume point. An interrupt
  // of an unknown kind -> nothing this path knows how to re-surface; one bad
  // apple makes the whole set unresumable, since the batch resume must answer
  // every interrupt. Either way, not resumable.
  if (interrupts.length === 0) return false
  if (interrupts.some((it) => !isRehydratableInterrupt(it.value))) {
    return false
  }

  // Drop the provisional 'Cancelled' cancelZombieRuns appended at boot before
  // re-surfacing, so history doesn't show "Cancelled" above a live approval.
  dropDanglingCancel(conversationId)
  // Then drop any stale approval rows from the interrupted window: pending
  // rows a previous rehydrate persisted, and resolved rows whose command never
  // produced a result before the crash (the batch dispatched but died before
  // any command completed). The interrupts checkpointed here are those same
  // approvals; the fresh pending rows persisted below replace them, so leaving
  // the old rows would show each approval twice under two event ids.
  dropDanglingApprovalRows(conversationId)

  // Re-park ALL pending cards. Interrupt ids are deterministic (XXH3 of the
  // task's checkpoint namespace), so the ids read from the checkpoint here are
  // exactly what the keyed resume targets after the restart. Security: this
  // only re-shows the approvals; no command auto-runs -- the user must answer
  // every card again, and only then does the batch resume dispatch.
  const items = new Map<string, ApprovalItem>()
  for (const pairing of pairInterruptsToCalls(interrupts, findDanglingRunCommandCalls(messages))) {
    const pendingCallId = randomUUID()
    let tool: ToolName
    let input: unknown
    let toolCallId: string | undefined
    const planArtifactId = planReviewArtifactIdOf(pairing.value)
    if (planArtifactId !== undefined) {
      // Plan pauses re-park from the payload, like edits: the dangling-call
      // scan is run_command-only so pairing.call is always null here, and
      // synthesizedApprovalCard carries the title + artifactId the card and
      // pane need. No ctx seeding (the Bb3 edit precedent): the replayed
      // submit_plan re-emits its artifact events itself (deterministic ids),
      // so only its tool_result text is a cosmetic history gap. Security:
      // nothing auto-resolves -- the user must answer the re-parked card, and
      // the artifact meanwhile stays pending-review.
      const card = synthesizedApprovalCard(pairing.value)
      tool = card.tool
      input = card.input
      toolCallId = card.toolCallId
    } else if ((pairing.value as { kind?: string } | null | undefined)?.kind === 'edit_file') {
      // Edit interrupts always re-park from the payload: the dangling-call
      // scan above is deliberately run_command-only, so pairing.call is null
      // for every edit (a toolCallId lookup misses the candidate list and the
      // fallback matcher rejects run_command candidates), and
      // synthesizedApprovalCard shows the TRUE resolved target while keeping
      // the raw path + toolCallId the denied-replay pin needs. ctx seeding
      // (the callIdMap/bridgedToolCalls block in the run_command branch) is
      // deliberately skipped for edits in Bb3: it only recovers the
      // post-resume tool_result row, and for writes the review pane is driven
      // by the staged-diff post-loop (backend.stagedFiles -> closeOutTurn's
      // file_diff), not toolMsgById -- an approved write's replay still lands
      // on disk and stages its diff regardless. Cost: the crash-resumed
      // edit's tool_result row is absent from history, a cosmetic gap.
      const card = synthesizedApprovalCard(pairing.value)
      tool = card.tool
      input = card.input
      toolCallId = card.toolCallId
    } else {
      const value = pairing.value as { command?: string; toolCallId?: unknown } | undefined
      tool = 'run_command'
      input = pairing.call ? pairing.call.args : { command: value?.command ?? '' }
      toolCallId =
        pairing.call?.id ?? (typeof value?.toolCallId === 'string' ? value.toolCallId : undefined)
      // Bug B residual (crash-resume): buildAgentAndContext made a FRESH ctx, so
      // without seeding, the resumed drive() neither recalls this event id
      // (callIdMap mints a new one that can't pair with the approved tool_call
      // row) nor re-iterates the checkpointed tool call at all (LangGraph doesn't
      // re-stream the AI message that carried it, and handleLLMEnd doesn't
      // re-fire for it) -- the command's tool_result was never persisted. Seed
      // both maps from the checkpointed messages: callIdMap so the tool_result's
      // callId is pendingCallId, bridgedToolCalls so drive()'s existing fallback
      // loop processes the call (resolveInterrupt's alreadyAnnounced.add
      // suppresses a duplicate tool_call emit, same as the live resume path).
      if (pairing.call) {
        ctx.callIdMap.set(pairing.call.id, pendingCallId)
        ctx.bridgedToolCalls.set(pairing.call.id, {
          id: pairing.call.id,
          name: pairing.call.name ?? 'run_command',
          args: pairing.call.args
        })
      }
    }
    // PERSIST (not emit-only) the pending tool_call: at boot the renderer may
    // not have this conversation loaded yet and openConvo rebuilds an
    // awaiting-approval conversation from the DB, so the pending approval must
    // live in history. The resolved tool_call reuses pendingCallId and is
    // written with appendOrReplaceEvent (resolveInterrupt), replacing this row
    // in place.
    emitAndPersist(conversationId, sink, {
      type: 'tool_call',
      id: pendingCallId,
      tool,
      input,
      approvalState: 'pending'
    })
    items.set(pendingCallId, {
      interruptId: pairing.interruptId,
      tool,
      input,
      toolCallId,
      ...(planArtifactId !== undefined ? { planReview: { artifactId: planArtifactId } } : {})
    })
  }
  pendingApprovals.set(conversationId, { ...ctx, agent, items })
  sink.setState(conversationId, 'awaiting-approval')
  return true
}

async function closeOutTurn(
  agent: ReturnType<typeof createDeepAgent>,
  ctx: DriveContext
): Promise<void> {
  // Auto-compaction marker: the summarization middleware records how many of
  // the oldest messages it folded into a summary in state._summarizationEvent.
  // If that cutoff advanced past the last marker we surfaced, emit a fresh
  // `compaction` event. Fully guarded — any read failure or an
  // absent/unchanged cutoff emits nothing and never disturbs the turn.
  try {
    const snapshot = await (agent as GetStateCapable).getState({
      configurable: { thread_id: ctx.conversationId }
    })
    const prevCutoff = getEvents(ctx.conversationId).reduce<number | null>(
      (acc, ev) => (ev.type === 'compaction' ? ev.summarizedCount : acc),
      null
    )
    const { advanced, summarizedCount } = compactionAdvanced(
      prevCutoff,
      snapshot.values?._summarizationEvent
    )
    if (advanced) {
      const compaction: Event = {
        type: 'compaction',
        id: randomUUID(),
        summarizedCount,
        createdAt: Date.now()
      }
      appendEvent(ctx.conversationId, compaction)
      ctx.sink.emit(ctx.conversationId, compaction)
    }
  } catch {
    // getState can throw on some provider/graph states; the marker is a
    // best-effort surface, never load-bearing for the turn.
  }

  if (ctx.backend.stagedFiles.length > 0) {
    emitAndPersist(ctx.conversationId, ctx.sink, {
      type: 'file_diff',
      id: randomUUID(),
      diffId: ctx.diffGroupId,
      files: ctx.backend.stagedFiles.map((f) => ({
        path: ctx.projectPath ? relative(ctx.projectPath, f.path) || f.path : f.path,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status
      }))
    })
  }

  const usageSnapshot = ctx.turnUsage.snapshot()
  const turnMeta: Event = {
    type: 'turn_meta',
    id: randomUUID(),
    provider: ctx.providerId,
    model: ctx.modelId,
    startedAt: ctx.startedAt,
    endedAt: Date.now(),
    ...(usageSnapshot ? { usage: usageSnapshot } : {})
  }
  appendEvent(ctx.conversationId, turnMeta)
  ctx.sink.emit(ctx.conversationId, turnMeta)

  // Mirrors legacy run.ts: fire-and-forget title generation on the first
  // completed turn, refreshing the sidebar via sink.metaChanged once the
  // title lands. Skipped on cancellation, same as legacy.
  if (!ctx.signal.aborted) {
    void maybeGenerateTitle(
      ctx.conversationId,
      ctx.providerId,
      ctx.modelId,
      ctx.userText,
      ctx.answerAccum.text,
      (id) => {
        const meta = getConversationMeta(id)
        if (meta) ctx.sink.metaChanged(meta)
      }
    )
  }

  ctx.sink.setState(ctx.conversationId, ctx.signal.aborted ? 'cancelled' : 'done')
}
