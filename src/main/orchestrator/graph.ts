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
import type { Event, ProviderId, ToolName } from '../../shared/types'
import type { RunSink } from '../ursa/run'
import { appendEvent, getConversationMeta } from '../db'
import { parseModelRef } from '../ursa/providers/registry'
import { maybeGenerateTitle } from '../ursa/title'
import { makeModel } from './models'
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
    configurable: { thread_id: ctx.conversationId }
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
      toolMsgById.set(id, prev ? (prev.concat(chunk) as ToolMessageChunk) : chunk)
      if (!toolAgentById.has(id)) toolAgentById.set(id, agentId)
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
    }
  }

  // Emit tool_call/tool_result Events for every tool call surfaced by this
  // invocation's AI message(s), in the order the model issued them (fix
  // carried from Task 5 review: these were previously dropped silently).
  for (const msgId of aiOrder) {
    const aiMsg = aiById.get(msgId)
    const msgAgentId = aiAgentById.get(msgId)
    for (const tc of aiMsg?.tool_calls ?? []) {
      if (!tc.id) continue
      // Mint (or recall) the local id for this provider tool-call id up
      // front, before checking alreadyAnnounced -- see callIdMap's doc
      // comment on DriveContext. Recall matters across the pause/resume
      // split: the same tc.id is seen again after resume, and must map to
      // the SAME local id that was used for the pre-pause tool_call emit.
      let localId = ctx.callIdMap.get(tc.id)
      if (!localId) {
        localId = randomUUID()
        ctx.callIdMap.set(tc.id, localId)
      }
      const toolResult = toolMsgById.get(tc.id)
      if (!toolResult) {
        // No result yet: this is the tool the graph paused on (run_command
        // awaiting approval). Check the checkpointed state to confirm, per
        // the raw-interrupt() pattern (planning/replatform-api-notes.md (d2)).
        const pending = await findPendingInterrupt(agent, ctx.conversationId)
        if (pending !== undefined) {
          if (pending.count > 1) {
            // Parallel interrupts: the approval-resume path issues a bare,
            // unkeyed `Command({ resume })` (continueAfterApproval below),
            // which cannot safely target one interrupt out of several
            // pending ones. Since this is the command-approval SECURITY
            // gate, silently applying that resume to an ambiguous set
            // could execute a command the user meant to deny, or leave a
            // second approval prompt never surfaced. Fail the turn
            // deterministically instead -- caught by the try/catch in
            // runGraph/continueAfterApproval, which emits a clear `error`
            // Event via failTurn(). Full multi-interrupt support (a
            // per-task keyed resume) is a follow-up; not needed for the POC.
            throw new Error(
              `${pending.count} tool calls require approval in the same step; ` +
                'parallel approvals are not yet supported.'
            )
          }
          // Not persisted here (matching legacy run.ts): only the final
          // approvalState ('approved'/'denied', emitted once resolved, see
          // continueAfterApproval below) is written to the events table.
          // Persisting this 'pending' row too would collide on the same
          // event id once the final state is appended.
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
        continue
      }
      // Prefer the agentId the tool_result chunk itself was namespaced
      // under (toolAgentById); fall back to the AI message's agentId if the
      // result somehow wasn't observed with a namespace (shouldn't happen,
      // but keeps attribution best-effort rather than silently dropping it).
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
      emitAndPersist(ctx.conversationId, ctx.sink, {
        type: 'tool_result',
        id: randomUUID(),
        callId: localId,
        output: truncated ? output.slice(0, 50000) + '\n… output truncated' : output,
        durationMs: 0,
        truncated,
        stats,
        agentId: resultAgentId
      })
    }
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

async function continueAfterApproval(pending: PendingApproval, approved: boolean): Promise<void> {
  const { agent, pendingCallId, pendingInput, ...ctx } = pending
  try {
    emitAndPersist(ctx.conversationId, ctx.sink, {
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
    if (result.paused && result.pendingCallId) {
      pendingApprovals.set(ctx.conversationId, {
        ...ctx,
        agent,
        pendingCallId: result.pendingCallId,
        pendingInput: result.pendingInput
      })
      return
    }
    await closeOutTurn(ctx)
  } catch (err) {
    await failTurn(ctx, err)
  }
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

export async function runGraph(opts: {
  conversationId: string
  userText: string
  modelRef: string
  sink: RunSink
  signal: AbortSignal
}): Promise<{ paused: boolean }> {
  const { conversationId, userText, modelRef, sink, signal } = opts
  const { provider: providerId, modelId } = parseModelRef(modelRef)
  const startedAt = Date.now()

  sink.setState(conversationId, 'running')
  const userEvent: Event = { type: 'user_message', id: randomUUID(), text: userText }
  sink.emit(conversationId, userEvent)
  appendEvent(conversationId, userEvent)

  const projectPath = getConversationMeta(conversationId)?.projectPath ?? null
  const model = makeModel(modelRef)
  const diffGroupId = randomUUID()
  const backend = projectPath
    ? new DiffFsBackend(conversationId, projectPath, diffGroupId)
    : undefined
  // A real SQLite-backed checkpointer (src/main/orchestrator/checkpointer.ts,
  // its own `checkpoints.db`, separate from the `events` table above) so the
  // graph's execution state survives a crash, not just the token stream
  // (verified construction/option name: planning/replatform-api-notes.md
  // section (e), `CreateDeepAgentParams.checkpointer?: BaseCheckpointSaver |
  // boolean`, deepagents/dist/agent-DURA4_mf.d.ts line ~2568), AND so raw
  // `interrupt()` calls (risk 4, tools.ts) can pause/resume this thread
  // (section (d2): "checkpointer is required for interrupts to survive
  // across the pause").
  const agent = createDeepAgent({
    model,
    checkpointer: getCheckpointer(),
    subagents: [RESEARCHER_SUBAGENT],
    ...(backend ? { backend, tools: buildTools(projectPath as string) } : {})
  })

  const ctx: DriveContext = {
    conversationId,
    sink,
    providerId,
    modelId,
    startedAt,
    userText,
    projectPath: projectPath ?? '',
    backend: backend ?? new DiffFsBackend(conversationId, '', diffGroupId),
    diffGroupId,
    signal,
    writeCursor: { i: 0 },
    alreadyAnnounced: new Set(),
    callIdMap: new Map()
  }

  try {
    const result = await drive(agent, { messages: [{ role: 'user', content: userText }] }, ctx)
    if (result.paused && result.pendingCallId) {
      pendingApprovals.set(conversationId, {
        ...ctx,
        agent,
        pendingCallId: result.pendingCallId,
        pendingInput: result.pendingInput
      })
      return { paused: true }
    }
    await closeOutTurn(ctx)
  } catch (err) {
    await failTurn(ctx, err)
  }
  return { paused: false }
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
      '',
      (id) => {
        const meta = getConversationMeta(id)
        if (meta) ctx.sink.metaChanged(meta)
      }
    )
  }

  ctx.sink.setState(ctx.conversationId, ctx.signal.aborted ? 'cancelled' : 'done')
}
