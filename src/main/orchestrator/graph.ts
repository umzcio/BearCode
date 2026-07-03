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

async function findPendingInterrupt(
  agent: unknown,
  threadId: string
): Promise<unknown | undefined> {
  const snapshot = await (agent as GetStateCapable).getState({
    configurable: { thread_id: threadId }
  })
  for (const task of snapshot.tasks) {
    if (task.interrupts.length > 0) return task.interrupts[0].value
  }
  return undefined
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
  // Tool-call ids whose tool_call Event has already been emitted by the
  // caller (the approval resume path emits the 'approved'/'denied' update
  // itself, before re-driving the stream) so drive() doesn't double-emit.
  alreadyAnnounced: Set<string>
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
  const answerId = randomUUID()
  let answer = ''
  let thinkId = ''
  let think = ''
  let thinkStartedAt = 0
  let thinkEndedAt = 0

  const aiById = new Map<string, AIMessageChunk>()
  const aiOrder: string[] = []
  const toolMsgById = new Map<string, ToolMessageChunk>()

  // subgraphs:true is set per the verified API notes so subagent streams are
  // tagged by namespace; this task has no subagents, so every chunk is the main
  // agent and no agentId is attributed. Subagent attribution lands with the
  // multi-agent task. (The main graph's own model node namespaces as
  // "model_request:<id>", which is NOT a subagent and must not be labelled.)
  const stream = await agent.stream(input, {
    streamMode: 'messages',
    subgraphs: true,
    signal: ctx.signal,
    configurable: { thread_id: ctx.conversationId }
  })

  for await (const item of stream) {
    const [, [chunk]] = item as MessagesStreamChunk
    if (isToolMessageChunk(chunk)) {
      const id = chunk.tool_call_id || chunk.id || randomUUID()
      const prev = toolMsgById.get(id)
      toolMsgById.set(id, prev ? (prev.concat(chunk) as ToolMessageChunk) : chunk)
      continue
    }
    const aiChunk = chunk as AIMessageChunk
    for (const block of aiChunk.contentBlocks ?? []) {
      const reasoning = reasoningTextOf(block)
      if (reasoning) {
        if (!thinkId) {
          thinkId = randomUUID()
          thinkStartedAt = Date.now()
        }
        think += reasoning
        ctx.sink.emit(
          ctx.conversationId,
          thinkingDeltaEvent(thinkId, think, Date.now() - thinkStartedAt)
        )
      } else if (block.type === 'text' && block.text) {
        if (thinkId && !thinkEndedAt) thinkEndedAt = Date.now()
        answer += block.text
        ctx.sink.emit(ctx.conversationId, textDeltaEvent(answerId, answer))
      }
    }
    const msgId = aiChunk.id ?? '__current__'
    const prevAi = aiById.get(msgId)
    if (!prevAi) aiOrder.push(msgId)
    aiById.set(msgId, prevAi ? (prevAi.concat(aiChunk) as AIMessageChunk) : aiChunk)
  }

  // Persist merged blocks (same pattern as legacy run.ts: deltas stream live,
  // only the closed, merged block is written to the events table).
  if (thinkId && think) {
    appendEvent(
      ctx.conversationId,
      thinkingDeltaEvent(thinkId, think, (thinkEndedAt || Date.now()) - thinkStartedAt)
    )
  }
  if (answer) {
    appendEvent(ctx.conversationId, textDeltaEvent(answerId, answer))
  }

  // Emit tool_call/tool_result Events for every tool call surfaced by this
  // invocation's AI message(s), in the order the model issued them (fix
  // carried from Task 5 review: these were previously dropped silently).
  for (const msgId of aiOrder) {
    const aiMsg = aiById.get(msgId)
    for (const tc of aiMsg?.tool_calls ?? []) {
      if (!tc.id) continue
      const toolResult = toolMsgById.get(tc.id)
      if (!toolResult) {
        // No result yet: this is the tool the graph paused on (run_command
        // awaiting approval). Check the checkpointed state to confirm, per
        // the raw-interrupt() pattern (planning/replatform-api-notes.md (d2)).
        const pendingValue = await findPendingInterrupt(agent, ctx.conversationId)
        if (pendingValue !== undefined) {
          emitAndPersist(ctx.conversationId, ctx.sink, {
            type: 'tool_call',
            id: tc.id,
            tool: (tc.name as ToolName) ?? 'run_command',
            input: tc.args,
            approvalState: 'pending'
          })
          ctx.sink.setState(ctx.conversationId, 'awaiting-approval')
          return { paused: true, pendingCallId: tc.id, pendingInput: tc.args }
        }
        // No result and no interrupt: the tool is still genuinely running
        // (shouldn't happen once the stream is exhausted) -- skip silently.
        continue
      }
      if (!ctx.alreadyAnnounced.has(tc.id)) {
        emitAndPersist(ctx.conversationId, ctx.sink, {
          type: 'tool_call',
          id: tc.id,
          tool: (tc.name as ToolName) ?? 'run_command',
          input: tc.args,
          approvalState: 'auto'
        })
      }
      const output = textOf(toolResult.content)
      const stats =
        tc.name === 'write_file' || tc.name === 'edit_file' ? nextStagedStats(ctx) : undefined
      const truncated = output.length > 50000
      emitAndPersist(ctx.conversationId, ctx.sink, {
        type: 'tool_result',
        id: randomUUID(),
        callId: tc.id,
        output: truncated ? output.slice(0, 50000) + '\n… output truncated' : output,
        durationMs: 0,
        truncated,
        stats
      })
    }
  }

  return { paused: false }
}

// One diff-backed backend + one interrupt-resume slot per in-flight turn.
interface PendingApproval extends DriveContext {
  agent: ReturnType<typeof createDeepAgent>
  pendingCallId: string
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
  pendingApprovals.delete(conversationId)
  void continueAfterApproval(pending, approved)
  return true
}

async function continueAfterApproval(pending: PendingApproval, approved: boolean): Promise<void> {
  const { agent, pendingCallId, ...ctx } = pending
  emitAndPersist(ctx.conversationId, ctx.sink, {
    type: 'tool_call',
    id: pendingCallId,
    tool: 'run_command',
    input: undefined,
    approvalState: approved ? 'approved' : 'denied'
  })
  ctx.alreadyAnnounced.add(pendingCallId)
  ctx.sink.setState(ctx.conversationId, 'running')
  try {
    const result = await drive(agent, new Command({ resume: approved }), ctx)
    if (result.paused && result.pendingCallId) {
      pendingApprovals.set(ctx.conversationId, {
        ...ctx,
        agent,
        pendingCallId: result.pendingCallId
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
    alreadyAnnounced: new Set()
  }

  try {
    const result = await drive(agent, { messages: [{ role: 'user', content: userText }] }, ctx)
    if (result.paused && result.pendingCallId) {
      pendingApprovals.set(conversationId, { ...ctx, agent, pendingCallId: result.pendingCallId })
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
