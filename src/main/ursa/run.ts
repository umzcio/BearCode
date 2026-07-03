// The ursa chat loop for Phase 2-3: streamText via the AI SDK, mapped onto
// BearCode's Event vocabulary. Streaming deltas are pushed to the renderer
// incrementally but persisted as one merged event per block when the block
// closes. Tools, approval gating, and the iteration cap arrive in Phases 4-5;
// the SDK never auto-executes anything here.
import { randomUUID } from 'crypto'
import { streamText } from 'ai'
import type { ModelMessage } from 'ai'
import type { ConversationMeta, Event, RunState } from '../../shared/types'
import { getProvider, parseModelRef } from './providers/registry'
import { systemPrompt } from './systemPrompt'
import { maybeGenerateTitle } from './title'
import * as db from '../db'

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
  for (const event of db.getEvents(conversationId)) {
    if (event.type === 'user_message') history.push({ role: 'user', content: event.text })
    else if (event.type === 'assistant_text' && event.text) {
      history.push({ role: 'assistant', content: event.text })
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
  db.setModelRef(conversationId, modelRef)

  // A retry after an error re-sends the same text; the unanswered user
  // message is already in history, so don't append a duplicate.
  const last = history[history.length - 1]
  const isRetry = last?.role === 'user' && last.content === userText
  if (!isRetry) {
    history.push({ role: 'user', content: userText })
  }
  const userEvent: Event = { type: 'user_message', id: randomUUID(), text: userText }
  sink.emit(conversationId, userEvent)
  if (!isRetry) db.appendEvent(conversationId, userEvent)

  const controller = new AbortController()
  aborts.set(conversationId, controller)
  sink.setState(conversationId, 'running')

  const startedAt = Date.now()
  let thinkingText = ''
  let thinkingId: string | null = null
  let thinkingStartedAt = 0
  let thinkingEndedAt = 0
  let answerText = ''
  let answerId: string | null = null
  let usage: { inputTokens: number; outputTokens: number } | undefined

  const persistBlocks = (): void => {
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
  }

  try {
    const result = streamText({
      model: provider.make(modelId),
      system: systemPrompt(workspacePaths.get(conversationId) ?? null),
      messages: history,
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
      } else if (part.type === 'finish') {
        const u = part.totalUsage
        if (u && u.inputTokens !== undefined && u.outputTokens !== undefined) {
          usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
        }
      } else if (part.type === 'error') {
        throw part.error
      }
    }

    if (answerText) {
      history.push({ role: 'assistant', content: answerText })
    }
    persistBlocks()
    const turnMeta: Event = {
      type: 'turn_meta',
      id: randomUUID(),
      provider: providerId,
      model: modelId,
      startedAt,
      endedAt: Date.now(),
      usage
    }
    sink.emit(conversationId, turnMeta)
    db.appendEvent(conversationId, turnMeta)
    sink.setState(conversationId, 'done')

    // First completed turn names the conversation, in the background.
    void maybeGenerateTitle(conversationId, providerId, modelId, userText, answerText, (id) => {
      const meta = db.getConversationMeta(id)
      if (meta) sink.metaChanged(meta)
    })
  } catch (err) {
    persistBlocks()
    const cancelled = controller.signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[ursa] run failed (${modelRef}):`, message)
    const errorEvent: Event = { type: 'error', id: randomUUID(), message, recoverable: true }
    sink.emit(conversationId, errorEvent)
    db.appendEvent(conversationId, errorEvent)
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  } finally {
    aborts.delete(conversationId)
    const meta = db.getConversationMeta(conversationId)
    if (meta) sink.metaChanged(meta)
  }
}
