import { randomUUID } from 'crypto'
import type {
  ApprovalDecision,
  AttachmentRef,
  Event,
  HermesAttachment
} from '../../shared/types'
import type { RunSink } from '../sink'
import {
  appendEvent,
  appendOrReplaceEvent,
  getConversationMeta,
  setHermesSessionId
} from '../db'
import { getSettings } from '../settings'
import { getHermesPlatformKey, getOrCreateHermesInstallationId } from '../keys'
import { HermesNativeTurn } from './nativeClient'
import { HERMES_MAX_TEXT_LENGTH } from './protocol'
import type { HermesServerEvent } from './protocol'

interface AssistantState {
  text: string
  persisted: boolean
  truncated: boolean
}

interface ActiveNativeTurn {
  turn: HermesNativeTurn
  pendingApprovals: Set<string>
  pendingClarifications: Set<string>
  toolStartedAt: Map<string, number>
  sink: RunSink
  toolCalls: Map<string, Extract<Event, { type: 'hermes_tool_call' }>>
  approvalToolCallIds: Map<string, string>
  clarifications: Map<string, Extract<Event, { type: 'hermes_clarification' }>>
}

const activeTurns = new Map<string, ActiveNativeTurn>()

function emitAndAppend(conversationId: string, sink: RunSink, event: Event): void {
  sink.emit(conversationId, event)
  appendEvent(conversationId, event)
}

function emitAndReplace(conversationId: string, sink: RunSink, event: Event): void {
  sink.emit(conversationId, event)
  appendOrReplaceEvent(conversationId, event)
}

function fail(
  conversationId: string,
  sink: RunSink,
  message: string,
  state: 'error' | 'cancelled' = 'error'
): { paused: false; failed: true } {
  emitAndAppend(conversationId, sink, {
    type: 'error',
    id: randomUUID(),
    message,
    recoverable: true
  })
  sink.setState(conversationId, state)
  return { paused: false, failed: true }
}

function toolStatus(status: string): 'completed' | 'failed' {
  return status === 'completed' ? 'completed' : 'failed'
}

export async function runHermesNative(
  conversationId: string,
  userText: string,
  attachments: AttachmentRef[],
  sink: RunSink,
  signal: AbortSignal
): Promise<{ paused: false; failed?: boolean }> {
  if (activeTurns.has(conversationId)) {
    return fail(conversationId, sink, 'A native Hermes turn is already active for this conversation.')
  }

  const settings = getSettings()
  const platformKey = getHermesPlatformKey()
  const installationId = getOrCreateHermesInstallationId()
  if (!settings.hermesNativeUrl || !platformKey || !installationId) {
    return fail(
      conversationId,
      sink,
      'Native Hermes is not configured. Set the native URL and platform key in Settings → Hermes.'
    )
  }

  const startedAt = Date.now()
  const assistants = new Map<string, AssistantState>()
  let latestAssistantId: string | undefined
  let completedSessionId: string | undefined
  let active!: ActiveNativeTurn

  const invalidateInteractions = (): void => {
    active.pendingApprovals.clear()
    active.pendingClarifications.clear()
    active.approvalToolCallIds.clear()
    active.clarifications.clear()
  }

  const persistAssistant = (messageId: string): void => {
    const assistant = assistants.get(messageId)
    if (!assistant || assistant.persisted || !assistant.text) return
    appendEvent(conversationId, {
      type: 'assistant_text',
      id: messageId,
      text: assistant.text
    })
    assistant.persisted = true
  }

  const onEvent = (wire: HermesServerEvent): void => {
    switch (wire.type) {
      case 'assistant.started':
        assistants.set(wire.payload.messageId, { text: '', persisted: false, truncated: false })
        latestAssistantId = wire.payload.messageId
        return
      case 'assistant.delta': {
        const assistant = assistants.get(wire.payload.messageId) ?? {
          text: '',
          persisted: false,
          truncated: false
        }
        if (assistant.truncated) return
        const next = wire.payload.replace === true
          ? wire.payload.text
          : assistant.text + wire.payload.text
        if (next.length > HERMES_MAX_TEXT_LENGTH) {
          assistant.text = next.slice(0, HERMES_MAX_TEXT_LENGTH)
          assistant.truncated = true
        } else {
          assistant.text = next
        }
        assistants.set(wire.payload.messageId, assistant)
        latestAssistantId = wire.payload.messageId
        sink.emit(conversationId, {
          type: 'assistant_text',
          id: wire.payload.messageId,
          text: assistant.text
        })
        return
      }
      case 'assistant.completed':
        persistAssistant(wire.payload.messageId)
        return
      case 'tool.started': {
        const event: Extract<Event, { type: 'hermes_tool_call' }> = {
          type: 'hermes_tool_call',
          id: wire.payload.toolCallId,
          name: wire.payload.name,
          label: wire.payload.label,
          status: 'running'
        }
        active.toolStartedAt.set(wire.payload.toolCallId, Date.now())
        active.toolCalls.set(wire.payload.toolCallId, event)
        emitAndReplace(conversationId, sink, event)
        return
      }
      case 'tool.progress': {
        const previous = active.toolCalls.get(wire.payload.toolCallId)
        const event: Extract<Event, { type: 'hermes_tool_call' }> = {
          ...(previous ?? {
            type: 'hermes_tool_call',
            id: wire.payload.toolCallId,
            name: 'tool'
          }),
          label: wire.payload.label,
          status: 'running'
        }
        active.toolCalls.set(wire.payload.toolCallId, event)
        emitAndReplace(conversationId, sink, event)
        return
      }
      case 'tool.completed': {
        const previous = active.toolCalls.get(wire.payload.toolCallId)
        const status = toolStatus(wire.payload.status)
        const event: Extract<Event, { type: 'hermes_tool_call' }> = {
          ...(previous ?? {
            type: 'hermes_tool_call',
            id: wire.payload.toolCallId,
            name: 'tool'
          }),
          label: previous?.label ?? wire.payload.status,
          status
        }
        active.toolCalls.set(wire.payload.toolCallId, event)
        emitAndReplace(conversationId, sink, event)
        const toolStartedAt = active.toolStartedAt.get(wire.payload.toolCallId)
        emitAndAppend(conversationId, sink, {
          type: 'hermes_tool_result',
          id: randomUUID(),
          callId: wire.payload.toolCallId,
          status,
          durationMs: toolStartedAt === undefined ? 0 : Math.max(0, Date.now() - toolStartedAt)
        })
        return
      }
      case 'approval.requested': {
        const previous = active.toolCalls.get(wire.payload.toolCallId)
        const event: Extract<Event, { type: 'hermes_tool_call' }> = {
          type: 'hermes_tool_call',
          id: wire.payload.toolCallId,
          name: previous?.name ?? 'tool',
          label: previous?.label ?? wire.payload.description,
          status: 'awaiting-approval',
          requestId: wire.payload.requestId,
          command: wire.payload.command,
          description: wire.payload.description,
          allowSession: wire.payload.allowSession,
          allowPermanent: wire.payload.allowPermanent,
          smartDenied: wire.payload.smartDenied
        }
        active.pendingApprovals.add(wire.payload.requestId)
        active.approvalToolCallIds.set(wire.payload.requestId, wire.payload.toolCallId)
        active.toolCalls.set(wire.payload.toolCallId, event)
        sink.emit(conversationId, event)
        return
      }
      case 'clarification.requested': {
        const event: Extract<Event, { type: 'hermes_clarification' }> = {
          type: 'hermes_clarification',
          id: wire.payload.requestId,
          requestId: wire.payload.requestId,
          question: wire.payload.question,
          choices: wire.payload.choices,
          state: 'pending'
        }
        active.pendingClarifications.add(wire.payload.requestId)
        active.clarifications.set(wire.payload.requestId, event)
        sink.emit(conversationId, event)
        return
      }
      case 'turn.completed':
        invalidateInteractions()
        completedSessionId = wire.payload.sessionId
        setHermesSessionId(conversationId, wire.payload.sessionId)
        {
          const meta = getConversationMeta(conversationId)
          if (meta) sink.metaChanged(meta)
        }
        return
      case 'turn.failed':
      case 'turn.cancelled':
        invalidateInteractions()
        return
      default:
        return
    }
  }

  const onAttachment = (attachment: HermesAttachment): void => {
    emitAndAppend(conversationId, sink, {
      type: 'assistant_attachment',
      id: attachment.id,
      attachment
    })
  }

  const turn = new HermesNativeTurn({
    url: settings.hermesNativeUrl,
    platformKey,
    installationId,
    conversationId,
    turnId: randomUUID(),
    text: userText,
    attachments,
    signal,
    onEvent,
    onAttachment
  })
  active = {
    turn,
    pendingApprovals: new Set(),
    pendingClarifications: new Set(),
    toolStartedAt: new Map(),
    sink,
    toolCalls: new Map(),
    approvalToolCallIds: new Map(),
    clarifications: new Map()
  }
  activeTurns.set(conversationId, active)

  try {
    const result = await turn.run()
    if (result === 'cancelled') {
      if (latestAssistantId) persistAssistant(latestAssistantId)
      return fail(conversationId, sink, 'Cancelled', 'cancelled')
    }
    if (!completedSessionId) {
      if (latestAssistantId) persistAssistant(latestAssistantId)
      return fail(conversationId, sink, 'Native Hermes completed without returning a session ID.')
    }
    emitAndAppend(conversationId, sink, {
      type: 'turn_meta',
      id: randomUUID(),
      provider: 'hermes',
      model: 'agent',
      startedAt,
      endedAt: Date.now()
    })
    sink.setState(conversationId, 'done')
    return { paused: false }
  } catch (error) {
    if (latestAssistantId) persistAssistant(latestAssistantId)
    const cancelled = signal.aborted
    return fail(
      conversationId,
      sink,
      cancelled ? 'Cancelled' : error instanceof Error ? error.message : 'Native Hermes request failed',
      cancelled ? 'cancelled' : 'error'
    )
  } finally {
    if (activeTurns.get(conversationId) === active) activeTurns.delete(conversationId)
  }
}

export function cancelHermesNative(conversationId: string): boolean {
  const active = activeTurns.get(conversationId)
  if (!active) return false
  active.turn.cancel()
  active.pendingApprovals.clear()
  active.pendingClarifications.clear()
  active.approvalToolCallIds.clear()
  active.clarifications.clear()
  return true
}

export function resolveHermesApproval(
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision
): boolean {
  const active = activeTurns.get(conversationId)
  if (!active?.pendingApprovals.has(requestId)) return false
  const toolCallId = active.approvalToolCallIds.get(requestId)
  const previous = toolCallId ? active.toolCalls.get(toolCallId) : undefined
  if (!toolCallId || !previous) return false

  active.turn.resolveApproval(requestId, decision)
  active.pendingApprovals.delete(requestId)
  active.approvalToolCallIds.delete(requestId)
  const event: Extract<Event, { type: 'hermes_tool_call' }> = {
    ...previous,
    status: decision === 'deny' ? 'failed' : 'running',
    approvalDecision: decision
  }
  active.toolCalls.set(toolCallId, event)
  emitAndReplace(conversationId, active.sink, event)
  return true
}

export function resolveHermesClarification(
  conversationId: string,
  requestId: string,
  response: string
): boolean {
  const active = activeTurns.get(conversationId)
  const previous = active?.clarifications.get(requestId)
  if (!active || !previous || !active.pendingClarifications.has(requestId)) return false

  active.turn.resolveClarification(requestId, response)
  active.pendingClarifications.delete(requestId)
  const event: Extract<Event, { type: 'hermes_clarification' }> = {
    ...previous,
    state: 'answered',
    response
  }
  active.clarifications.set(requestId, event)
  emitAndReplace(conversationId, active.sink, event)
  return true
}
