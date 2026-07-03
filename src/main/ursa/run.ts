// The ursa agent loop (spec 6.3): streamText via the AI SDK, wrapped in
// BearCode's own iteration cap, tool execution, and event emission. The SDK
// never auto-executes a tool. Streaming deltas are pushed to the renderer
// incrementally but persisted as one merged event per block on close.
// Approval gating and write tools land in Phase 5.
import { randomUUID } from 'crypto'
import { streamText, tool } from 'ai'
import type { AssistantModelMessage, ModelMessage, Tool, ToolModelMessage } from 'ai'
import type { ConversationMeta, Event, RunState, ToolName } from '../../shared/types'
import { getProvider, parseModelRef } from './providers/registry'
import { systemPrompt } from './systemPrompt'
import { maybeGenerateTitle } from './title'
import { TOOLS } from './tools'
import { stageFile } from './diffs'
import { getSettings } from '../settings'
import * as db from '../db'
import { relative } from 'path'
import type { FileDiffFile } from '../../shared/types'

// Pending run_command approvals: callId -> resolver (spec 6.2).
const approvals = new Map<string, (approved: boolean) => void>()
export function resolveApproval(callId: string, approved: boolean): void {
  approvals.get(callId)?.(approved)
  approvals.delete(callId)
}

const MAX_ITERATIONS = 25

export interface RunSink {
  emit(conversationId: string, event: Event): void
  setState(conversationId: string, state: RunState): void
  metaChanged(meta: ConversationMeta): void
}

// Provider-neutral conversation history (the AI SDK message format is the
// neutral format), rebuilt from persisted events on first use per session.
const histories = new Map<string, ModelMessage[]>()
const workspacePaths = new Map<string, string | null>()
const aborts = new Map<string, AbortController>()

function loadHistory(conversationId: string): ModelMessage[] {
  const cached = histories.get(conversationId)
  if (cached) return cached
  const history: ModelMessage[] = []
  const pendingCalls = new Map<string, ToolName>()
  for (const event of db.getEvents(conversationId)) {
    if (event.type === 'user_message') {
      history.push({ role: 'user', content: event.text })
    } else if (event.type === 'assistant_text' && event.text) {
      history.push({ role: 'assistant', content: event.text })
    } else if (event.type === 'tool_call') {
      pendingCalls.set(event.id, event.tool)
      history.push({
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: event.id, toolName: event.tool, input: event.input }
        ]
      })
    } else if (event.type === 'tool_result') {
      const toolName = pendingCalls.get(event.callId) ?? 'read_file'
      history.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: event.callId,
            toolName,
            output: { type: 'text', value: event.output }
          }
        ]
      })
    }
  }
  histories.set(conversationId, history)
  return history
}

export function setWorkspace(conversationId: string, projectPath: string | null): void {
  workspacePaths.set(conversationId, projectPath)
}

export function forgetConversation(conversationId: string): void {
  aborts.get(conversationId)?.abort()
  aborts.delete(conversationId)
  histories.delete(conversationId)
  workspacePaths.delete(conversationId)
}

export function clearConversations(): void {
  for (const [, controller] of aborts) controller.abort()
  aborts.clear()
  histories.clear()
  workspacePaths.clear()
}

export function cancelRun(conversationId: string): void {
  aborts.get(conversationId)?.abort()
}

function buildAiTools(): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const [name, def] of Object.entries(TOOLS)) {
    out[name] = tool({ description: def.description, inputSchema: def.inputSchema })
  }
  return out
}

export async function startRun(
  conversationId: string,
  userText: string,
  modelRef: string,
  sink: RunSink
): Promise<void> {
  if (aborts.has(conversationId)) {
    throw new Error('A run is already active for this conversation')
  }

  const { provider: providerId, modelId } = parseModelRef(modelRef)
  const provider = getProvider(providerId)
  const history = loadHistory(conversationId)
  const projectPath = workspacePaths.get(conversationId) ?? null
  db.setModelRef(conversationId, modelRef)

  const last = history[history.length - 1]
  const isRetry = last?.role === 'user' && last.content === userText
  if (!isRetry) history.push({ role: 'user', content: userText })
  const userEvent: Event = { type: 'user_message', id: randomUUID(), text: userText }
  sink.emit(conversationId, userEvent)
  if (!isRetry) db.appendEvent(conversationId, userEvent)

  const controller = new AbortController()
  aborts.set(conversationId, controller)
  sink.setState(conversationId, 'running')

  const startedAt = Date.now()
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let useTools = projectPath !== null
  let toolsRetried = false
  const diffGroupId = randomUUID()
  const stagedFiles: FileDiffFile[] = []

  const emitAndPersist = (event: Event): void => {
    sink.emit(conversationId, event)
    db.appendEvent(conversationId, event)
  }

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let thinkingText = ''
      let thinkingId: string | null = null
      let thinkingStartedAt = 0
      let thinkingEndedAt = 0
      let answerText = ''
      let answerId: string | null = null
      const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = []

      try {
        const result = streamText({
          model: provider.make(modelId),
          system: systemPrompt(projectPath, useTools),
          messages: history,
          tools: useTools ? buildAiTools() : undefined,
          abortSignal: controller.signal,
          providerOptions: provider.providerOptions?.(modelId)
        })

        for await (const part of result.fullStream) {
          if (part.type === 'reasoning-delta') {
            if (!thinkingId) {
              thinkingId = randomUUID()
              thinkingStartedAt = Date.now()
            }
            thinkingText += part.text
            sink.emit(conversationId, {
              type: 'thinking',
              id: thinkingId,
              text: thinkingText,
              durationMs: Date.now() - thinkingStartedAt
            })
          } else if (part.type === 'text-delta') {
            if (!answerId) answerId = randomUUID()
            if (thinkingId && !thinkingEndedAt) thinkingEndedAt = Date.now()
            answerText += part.text
            sink.emit(conversationId, { type: 'assistant_text', id: answerId, text: answerText })
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input
            })
          } else if (part.type === 'finish') {
            const u = part.totalUsage
            if (u && u.inputTokens !== undefined && u.outputTokens !== undefined) {
              usage = {
                inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens,
                outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens
              }
            }
          } else if (part.type === 'error') {
            throw part.error
          }
        }
      } catch (err) {
        // Some models (often local ones) reject tool definitions outright:
        // retry once without tools and say so (spec section 5).
        const msg = err instanceof Error ? err.message : String(err)
        if (useTools && !toolsRetried && /tool/i.test(msg) && !controller.signal.aborted) {
          toolsRetried = true
          useTools = false
          emitAndPersist({
            type: 'error',
            id: randomUUID(),
            message: 'Tools are unavailable for this model. Continuing without tools.',
            recoverable: false
          })
          continue
        }
        throw err
      }

      // Persist merged streaming blocks for this iteration.
      if (thinkingId && thinkingText) {
        db.appendEvent(conversationId, {
          type: 'thinking',
          id: thinkingId,
          text: thinkingText,
          durationMs: (thinkingEndedAt || Date.now()) - thinkingStartedAt
        })
      }
      if (answerId && answerText) {
        db.appendEvent(conversationId, { type: 'assistant_text', id: answerId, text: answerText })
      }

      if (toolCalls.length === 0) {
        if (answerText) history.push({ role: 'assistant', content: answerText })
        break
      }

      // Record the assistant turn (text + tool calls) in neutral history.
      const assistantMsg: AssistantModelMessage = {
        role: 'assistant',
        content: [
          ...(answerText ? [{ type: 'text' as const, text: answerText }] : []),
          ...toolCalls.map((c) => ({
            type: 'tool-call' as const,
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.input
          }))
        ]
      }
      history.push(assistantMsg)

      const toolMsg: ToolModelMessage = { role: 'tool', content: [] }
      for (const call of toolCalls) {
        const def = TOOLS[call.toolName as ToolName]
        const needsApproval = Boolean(def?.requiresApproval) && !getSettings().autoApproveCommands
        let approved = true
        if (needsApproval) {
          // Pause the run for Run/Deny (spec 6.2). Persist only the decided
          // state; a quit while pending becomes Cancelled on next boot.
          sink.emit(conversationId, {
            type: 'tool_call',
            id: call.toolCallId,
            tool: call.toolName as ToolName,
            input: call.input,
            approvalState: 'pending'
          })
          sink.setState(conversationId, 'awaiting-approval')
          approved = await new Promise<boolean>((resolveApprovalPromise) => {
            approvals.set(call.toolCallId, resolveApprovalPromise)
            controller.signal.addEventListener('abort', () => resolveApprovalPromise(false))
          })
          if (controller.signal.aborted) throw new Error('Cancelled')
          sink.setState(conversationId, 'running')
        }
        emitAndPersist({
          type: 'tool_call',
          id: call.toolCallId,
          tool: call.toolName as ToolName,
          input: call.input,
          approvalState: needsApproval ? (approved ? 'approved' : 'denied') : 'auto'
        })
        const toolStartedAt = Date.now()
        let output: string
        let exitCode: number | undefined
        let stats: Extract<Event, { type: 'tool_result' }>['stats']
        if (!approved) {
          output = 'User denied this command.'
        } else {
          try {
            if (!def || !projectPath) throw new Error(`Unknown tool: ${call.toolName}`)
            const raw = await def.execute(call.input, {
              projectPath,
              stage: (absPath, beforeText, afterText) => {
                const staged = stageFile(
                  diffGroupId,
                  conversationId,
                  absPath,
                  beforeText,
                  afterText
                )
                stagedFiles.push(staged)
                return {
                  path: relative(projectPath, staged.path) || staged.path,
                  status: staged.status,
                  additions: staged.additions,
                  deletions: staged.deletions
                }
              }
            })
            if (typeof raw === 'string') {
              output = raw
            } else {
              output = raw.output
              exitCode = raw.exitCode
              stats = raw.stats
            }
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        const truncated = output.length > 50000
        if (truncated) output = output.slice(0, 50000) + '\n… output truncated'
        emitAndPersist({
          type: 'tool_result',
          id: randomUUID(),
          callId: call.toolCallId,
          output,
          exitCode,
          durationMs: Date.now() - toolStartedAt,
          truncated,
          stats
        })
        toolMsg.content.push({
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: 'text', value: output }
        })
      }
      history.push(toolMsg)
    }

    if (stagedFiles.length > 0) {
      emitAndPersist({
        type: 'file_diff',
        id: randomUUID(),
        diffId: diffGroupId,
        files: stagedFiles.map((f) => ({
          path: projectPath ? relative(projectPath, f.path) : f.path,
          additions: f.additions,
          deletions: f.deletions,
          status: f.status
        }))
      })
    }

    const turnMeta: Event = {
      type: 'turn_meta',
      id: randomUUID(),
      provider: providerId,
      model: modelId,
      startedAt,
      endedAt: Date.now(),
      usage
    }
    emitAndPersist(turnMeta)
    sink.setState(conversationId, 'done')

    const lastMsg = history[history.length - 1]
    const finalText =
      lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' ? lastMsg.content : ''
    void maybeGenerateTitle(conversationId, providerId, modelId, userText, finalText, (id) => {
      const meta = db.getConversationMeta(id)
      if (meta) sink.metaChanged(meta)
    })
  } catch (err) {
    const cancelled = controller.signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[ursa] run failed (${modelRef}):`, message)
    emitAndPersist({ type: 'error', id: randomUUID(), message, recoverable: true })
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  } finally {
    aborts.delete(conversationId)
    const meta = db.getConversationMeta(conversationId)
    if (meta) sink.metaChanged(meta)
  }
}
