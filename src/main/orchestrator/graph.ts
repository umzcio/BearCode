// The orchestrator's streaming graph: createDeepAgent() is called with a
// custom filesystem backend (fsBackend.ts, routes writes through
// src/main/ursa/diffs.ts stageFile) and one custom tool (tools.ts,
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
import { createDeepAgent } from 'deepagents'
import { Command } from '@langchain/langgraph'
import type { AIMessageChunk, BaseMessageChunk, ToolMessageChunk } from '@langchain/core/messages'
import { isToolMessageChunk } from '@langchain/core/messages'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'
import type { Event, ProviderId, ToolName } from '../../shared/types'
import type { RunSink } from '../sink'
import { appendEvent, appendOrReplaceEvent, dropDanglingCancel, getConversationMeta } from '../db'
import { parseModelRef } from '../ursa/providers/registry'
import { maybeGenerateTitle } from '../ursa/title'
import { makeModel } from './models'
import { orchestratorSystemPrompt } from './systemPrompt'
import { textDeltaEvent, thinkingDeltaEvent } from './bridge'
import { getCheckpointer } from './checkpointer'
import { DiffFsBackend } from './fsBackend'
import { buildTools } from './tools'

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
}
type GetStateCapable = { getState(config: unknown): Promise<StateSnapshotLike> }

// `count` lets the caller detect the parallel-interrupt case (more than one
// approval-requiring tool call raised in the same superstep) and refuse to
// guess which one a bare `Command({ resume })` should target.
interface PendingInterruptInfo {
  value: unknown
  count: number
}

async function findPendingInterrupt(
  agent: unknown,
  threadId: string
): Promise<PendingInterruptInfo | undefined> {
  const snapshot = await (agent as GetStateCapable).getState({
    configurable: { thread_id: threadId }
  })
  let count = 0
  let value: unknown
  for (const task of snapshot.tasks) {
    for (const it of task.interrupts) {
      if (count === 0) value = it.value
      count += 1
    }
  }
  return count > 0 ? { value, count } : undefined
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
}

interface DriveResult {
  paused: boolean
  pendingCallId?: string
  pendingInput?: unknown
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
// unseen one. Unknown interrupt kinds pass (nothing to verify against).
// Exported for tests.
export function interruptBelongsToToolCall(
  interruptValue: unknown,
  tc: { name?: string; args?: unknown }
): boolean {
  const value = interruptValue as { kind?: string; command?: string } | null | undefined
  if (value?.kind !== 'run_command') return true
  if (tc.name !== 'run_command') return false
  return (tc.args as { command?: unknown } | null | undefined)?.command === value.command
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
    private readonly bridgedAnswerText: { text: string }
  ) {
    super()
  }
  handleLLMStart(_llm: unknown, _prompts: string[], runId: string): void {
    this.startedAt.set(runId, Date.now())
    // A new model call: forget the previous call's answer-start so this call's
    // thinking time is measured against its own first answer token.
    this.answerStartedAt.t = null
  }
  handleLLMEnd(output: LLMResult, runId: string): void {
    const started = this.startedAt.get(runId) ?? Date.now()
    this.startedAt.delete(runId)
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
        ctx.bridgedAnswerText
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
  // message(s) issued, in order. processToolCall handles one call; it returns a
  // DriveResult when the graph paused on it (run_command awaiting approval), so
  // the caller propagates the pause, or null to continue to the next call.
  const processToolCall = async (
    tc: { id?: string; name?: string; args?: unknown },
    msgAgentId: string | undefined
  ): Promise<DriveResult | null> => {
    if (!tc.id) return null
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
    if (!toolResult) {
      // No result yet: this is the tool the graph paused on (run_command
      // awaiting approval). Check the checkpointed state to confirm, per the
      // raw-interrupt() pattern (planning/replatform-api-notes.md (d2)).
      const pending = await findPendingInterrupt(agent, ctx.conversationId)
      if (pending !== undefined) {
        if (pending.count > 1) {
          // Parallel interrupts: the approval-resume path issues a bare, unkeyed
          // `Command({ resume })` (continueAfterApproval below), which cannot
          // safely target one interrupt out of several pending ones. Since this
          // is the command-approval SECURITY gate, silently applying that resume
          // to an ambiguous set could execute a command the user meant to deny,
          // or leave a second approval prompt never surfaced. Fail the turn
          // deterministically instead -- caught by the try/catch in
          // runGraph/continueAfterApproval, which emits a clear `error` Event via
          // failTurn(). Full multi-interrupt support (a per-task keyed resume) is
          // a follow-up; not needed for the POC.
          throw new Error(
            `${pending.count} tool calls require approval in the same step; ` +
              'parallel approvals are not yet supported.'
          )
        }
        // The interrupt exists, but is it THIS call's? A no-result candidate
        // can be a stale bridged entry from a prior segment (Bug A follow-up:
        // the nudge re-drive iterates ctx.bridgedToolCalls again with a fresh
        // per-drive toolMsgById, so every previously completed bridged call
        // has "no result" here). Skip it and let the true owner -- also in
        // the candidate list -- claim the interrupt.
        if (!interruptBelongsToToolCall(pending.value, tc)) return null
        // Not persisted here (matching legacy run.ts): only the final
        // approvalState ('approved'/'denied', emitted once resolved, see
        // continueAfterApproval below) is written to the events table.
        // Persisting this 'pending' row too would collide on the same event id
        // once the final state is appended.
        ctx.sink.emit(ctx.conversationId, {
          type: 'tool_call',
          id: localId,
          tool: (tc.name as ToolName) ?? 'run_command',
          input: tc.args,
          approvalState: 'pending',
          agentId: msgAgentId
        })
        ctx.sink.setState(ctx.conversationId, 'awaiting-approval')
        return { paused: true, pendingCallId: localId, pendingInput: tc.args }
      }
      // No result and no interrupt: the tool is still genuinely running
      // (shouldn't happen once the stream is exhausted) -- skip silently.
      return null
    }
    // This call has completed: drop it from the bridged fallback so a later
    // drive() segment (approval resume, empty-final nudge) never re-iterates
    // it as a stale no-result candidate that could misclaim a NEW pending
    // interrupt. The still-pending call is deliberately NOT pruned -- it must
    // survive the pause/resume split (see bridgedToolCalls' doc comment).
    // Safe mid-iteration: Map deletion during values() iteration is defined.
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
    return null
  }

  // First, the tool calls the stream surfaced (most providers), recording their
  // ids so the fallback below doesn't process the same call twice.
  const processedTcIds = new Set<string>()
  for (const msgId of aiOrder) {
    const aiMsg = aiById.get(msgId)
    const msgAgentId = aiAgentById.get(msgId)
    for (const tc of aiMsg?.tool_calls ?? []) {
      if (tc.id) processedTcIds.add(tc.id)
      const result = await processToolCall(tc, msgAgentId)
      if (result) return result
    }
  }
  // Then the fallback: tool calls Deep Agents stripped from the stream (Gemini
  // bundles them into dropped thought-bearing chunks) but that handleLLMEnd
  // recorded on ctx.bridgedToolCalls. Attributed to the main agent -- handleLLMEnd
  // carries no lc_agent_name namespace, the same caveat as the reasoning bridge.
  // Pause/resume dedup is handled inside processToolCall (callIdMap recall + the
  // alreadyAnnounced guard), exactly as for streamed calls.
  for (const tc of ctx.bridgedToolCalls.values()) {
    if (processedTcIds.has(tc.id)) continue
    const result = await processToolCall(tc, undefined)
    if (result) return result
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

// One diff-backed backend + one interrupt-resume slot per in-flight turn.
interface PendingApproval extends DriveContext {
  agent: ReturnType<typeof createDeepAgent>
  pendingCallId: string
  pendingInput: unknown
}
const pendingApprovals = new Map<string, PendingApproval>()

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
// (IPC bridge for bearcode:tools:approve). Resumes the paused graph with
// `Command({ resume: approved })` and drives it to completion or the next
// interrupt. Returns false if there was nothing pending for this
// conversation/callId (e.g. a stale button click).
export function resolveInterrupt(
  conversationId: string,
  callId: string,
  approved: boolean
): boolean {
  const pending = pendingApprovals.get(conversationId)
  if (!pending || pending.pendingCallId !== callId) return false
  // Defense in depth: cancelRunOrchestrator (src/main/orchestrator/index.ts)
  // is the primary fix -- it deletes this conversation's pendingApprovals
  // entry (via cancelPendingApproval below) the instant Stop is clicked, so
  // a later Approve/Deny normally finds nothing here at all. But if a Stop
  // and an in-flight Approve/Deny IPC call ever race, ctx.signal.aborted is
  // the authoritative "this run is over" signal (same field failTurn below
  // checks), so refuse to resume a cancelled run even if its pending-approval
  // entry is somehow still present.
  if (pending.signal.aborted) {
    pendingApprovals.delete(conversationId)
    return false
  }
  pendingApprovals.delete(conversationId)
  void continueAfterApproval(pending, approved)
  return true
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
// Emits the same 'denied' tool_call shape a real Deny click would, so the
// renderer's PendingCommand UI (which keys off approvalState) stops showing
// live Approve/Deny buttons for it. Returns the sink so the caller (which
// only tracks AbortControllers, not sinks, per conversation) can finish
// tearing the run down to a terminal 'cancelled' state.
export function cancelPendingApproval(conversationId: string): RunSink | undefined {
  const pending = pendingApprovals.get(conversationId)
  if (!pending) return undefined
  pendingApprovals.delete(conversationId)
  emitAndPersist(pending.conversationId, pending.sink, {
    type: 'tool_call',
    id: pending.pendingCallId,
    tool: 'run_command',
    input: pending.pendingInput,
    approvalState: 'denied'
  })
  return pending.sink
}

// Silent teardown for conversation delete/clear: drop any parked approval
// without emitting a denied tool_call or touching the DB, since the
// conversation itself is being removed. (cancelPendingApproval, by contrast,
// is the Stop path and drives the conversation to a terminal 'cancelled'
// state the renderer still shows.)
export function forgetPendingApproval(conversationId: string): void {
  pendingApprovals.delete(conversationId)
}

export function clearAllPendingApprovals(): void {
  pendingApprovals.clear()
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
  if (final.paused && final.pendingCallId) {
    pendingApprovals.set(ctx.conversationId, {
      ...ctx,
      agent,
      pendingCallId: final.pendingCallId,
      pendingInput: final.pendingInput
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
  await closeOutTurn(ctx)
  return false
}

async function continueAfterApproval(pending: PendingApproval, approved: boolean): Promise<void> {
  const { agent, pendingCallId, pendingInput, ...ctx } = pending
  try {
    // appendOrReplaceEvent, not emitAndPersist: the resolved tool_call reuses
    // pendingCallId. In the live flow the pending row was never persisted so
    // this inserts (unchanged); in the crash-resume flow (A2) rehydratePausedRun
    // persisted the pending row, so this replaces it in place rather than
    // colliding on events.id.
    ctx.sink.emit(ctx.conversationId, {
      type: 'tool_call',
      id: pendingCallId,
      tool: 'run_command',
      input: pendingInput,
      approvalState: approved ? 'approved' : 'denied'
    })
    appendOrReplaceEvent(ctx.conversationId, {
      type: 'tool_call',
      id: pendingCallId,
      tool: 'run_command',
      input: pendingInput,
      approvalState: approved ? 'approved' : 'denied'
    })
    ctx.alreadyAnnounced.add(pendingCallId)
    ctx.sink.setState(ctx.conversationId, 'running')
    // { approved } (not a bare boolean) -- see tools.ts's interrupt() call
    // for why: LangGraph's Command(resume) rejects falsy resume values.
    const result = await drive(agent, new Command({ resume: { approved } }), ctx)
    if (await settleTurn(agent, result, ctx)) return
  } catch (err) {
    await failTurn(ctx, err)
  }
  // Reached only on a terminal settle (closeOutTurn or failTurn), never on the
  // re-pause early return above -- so index.ts clears the AbortController it
  // kept alive across the pause exactly once the resumed run is truly over.
  onResumeSettled?.(ctx.conversationId)
}

async function failTurn(ctx: DriveContext, err: unknown): Promise<void> {
  const cancelled = ctx.signal.aborted
  const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
  if (!cancelled)
    console.error(`[ursa] orchestrator resume failed (${ctx.conversationId}):`, message)
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
function buildAgentAndContext(
  conversationId: string,
  modelRef: string,
  userText: string,
  sink: RunSink,
  signal: AbortSignal
): { agent: ReturnType<typeof createDeepAgent>; ctx: DriveContext } {
  const { provider: providerId, modelId } = parseModelRef(modelRef)
  const projectPath = getConversationMeta(conversationId)?.projectPath ?? null
  const model = makeModel(modelRef)
  const diffGroupId = randomUUID()
  const backend = projectPath
    ? new DiffFsBackend(conversationId, projectPath, diffGroupId)
    : undefined
  const agent = createDeepAgent({
    model,
    systemPrompt: orchestratorSystemPrompt(projectPath),
    checkpointer: getCheckpointer(),
    subagents: [RESEARCHER_SUBAGENT],
    ...(backend ? { backend, tools: buildTools(projectPath as string, conversationId) } : {})
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
    emptyFinalRetried: { done: false }
  }
  return { agent, ctx }
}

export async function runGraph(opts: {
  conversationId: string
  userText: string
  modelRef: string
  sink: RunSink
  signal: AbortSignal
}): Promise<{ paused: boolean }> {
  const { conversationId, userText, modelRef, sink, signal } = opts

  sink.setState(conversationId, 'running')
  const userEvent: Event = {
    type: 'user_message',
    id: randomUUID(),
    text: userText,
    createdAt: Date.now()
  }
  sink.emit(conversationId, userEvent)
  appendEvent(conversationId, userEvent)

  const { agent, ctx } = buildAgentAndContext(conversationId, modelRef, userText, sink, signal)

  try {
    const result = await drive(agent, { messages: [{ role: 'user', content: userText }] }, ctx)
    if (await settleTurn(agent, result, ctx)) return { paused: true }
  } catch (err) {
    await failTurn(ctx, err)
  }
  return { paused: false }
}

// Full crash-resume (A2). Called at boot for a dangling conversation: rebuilds
// the agent (same checkpointer + thread_id, so it reads the persisted execution
// state) and checks whether the run died parked at a command-approval interrupt.
// If so, re-surfaces the approval and re-parks it in pendingApprovals so the
// existing resolveApprovalOrchestrator -> continueAfterApproval path resumes the
// graph from the checkpoint. Returns true if it re-parked a pending approval,
// false if there was nothing safely resumable (caller then degrades to
// 'cancelled'). Security: this only re-shows the approval; the command never
// auto-runs -- the user must Approve again.
export async function rehydratePausedRun(
  conversationId: string,
  modelRef: string,
  userText: string,
  sink: RunSink,
  signal: AbortSignal
): Promise<boolean> {
  const { agent, ctx } = buildAgentAndContext(conversationId, modelRef, userText, sink, signal)
  const pending = await findPendingInterrupt(agent, conversationId)
  // No interrupt -> a mid-stream crash with no safe resume point. count > 1 ->
  // parallel interrupts, which the resume path can't disambiguate (same guard
  // as the live drive() loop). Either way, not resumable.
  if (!pending || pending.count > 1) return false
  const value = pending.value as { kind?: string; command?: string } | undefined
  if (value?.kind !== 'run_command') return false

  // Drop the provisional 'Cancelled' cancelZombieRuns appended at boot before
  // re-surfacing, so history doesn't show "Cancelled" above a live approval.
  dropDanglingCancel(conversationId)

  const pendingCallId = randomUUID()
  const pendingInput = { command: value.command ?? '' }
  // PERSIST (not emit-only) the pending tool_call: at boot the renderer may not
  // have this conversation loaded yet and openConvo rebuilds an awaiting-approval
  // conversation from the DB, so the pending approval must live in history. The
  // resolved tool_call reuses pendingCallId and is written with
  // appendOrReplaceEvent (continueAfterApproval), replacing this row in place.
  emitAndPersist(conversationId, sink, {
    type: 'tool_call',
    id: pendingCallId,
    tool: 'run_command',
    input: pendingInput,
    approvalState: 'pending'
  })
  pendingApprovals.set(conversationId, { ...ctx, agent, pendingCallId, pendingInput })
  sink.setState(conversationId, 'awaiting-approval')
  return true
}

async function closeOutTurn(ctx: DriveContext): Promise<void> {
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

  const turnMeta: Event = {
    type: 'turn_meta',
    id: randomUUID(),
    provider: ctx.providerId,
    model: ctx.modelId,
    startedAt: ctx.startedAt,
    endedAt: Date.now()
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
