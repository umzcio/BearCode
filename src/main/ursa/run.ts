// The ursa chat loop for Phase 2: streamText via the AI SDK, mapped onto
// BearCode's Event vocabulary. Tools, approval gating, and the iteration cap
// wrap around this in Phases 4-5; the SDK never auto-executes anything here.
import { randomUUID } from 'crypto'
import { streamText } from 'ai'
import type { ModelMessage } from 'ai'
import type { Event, RunState } from '../../shared/types'
import { getProvider, parseModelRef } from './providers/registry'
import { systemPrompt } from './systemPrompt'

export interface RunSink {
  emit(conversationId: string, event: Event): void
  setState(conversationId: string, state: RunState): void
}

// Provider-neutral conversation history (the AI SDK message format is the
// neutral format). In-memory until SQLite lands in Phase 3.
const histories = new Map<string, ModelMessage[]>()
const workspacePaths = new Map<string, string | null>()
const aborts = new Map<string, AbortController>()

export function setWorkspace(conversationId: string, projectPath: string | null): void {
  workspacePaths.set(conversationId, projectPath)
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

  const history = histories.get(conversationId) ?? []
  histories.set(conversationId, history)

  // A retry after an error re-sends the same text; the unanswered user
  // message is already in history, so don't append a duplicate.
  const last = history[history.length - 1]
  const isRetry = last?.role === 'user' && last.content === userText
  if (!isRetry) {
    history.push({ role: 'user', content: userText })
  }
  sink.emit(conversationId, { type: 'user_message', id: randomUUID(), text: userText })

  const controller = new AbortController()
  aborts.set(conversationId, controller)
  sink.setState(conversationId, 'running')

  const startedAt = Date.now()
  let thinkingText = ''
  let thinkingId: string | null = null
  let thinkingStartedAt = 0
  let answerText = ''
  let answerId: string | null = null
  let usage: { inputTokens: number; outputTokens: number } | undefined

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
    sink.emit(conversationId, {
      type: 'turn_meta',
      id: randomUUID(),
      provider: providerId,
      model: modelId,
      startedAt,
      endedAt: Date.now(),
      usage
    })
    sink.setState(conversationId, 'done')
  } catch (err) {
    if (controller.signal.aborted) {
      sink.emit(conversationId, {
        type: 'error',
        id: randomUUID(),
        message: 'Cancelled',
        recoverable: true
      })
      sink.setState(conversationId, 'cancelled')
    } else {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ursa] run failed (${modelRef}):`, message)
      sink.emit(conversationId, {
        type: 'error',
        id: randomUUID(),
        message,
        recoverable: true
      })
      sink.setState(conversationId, 'error')
    }
  } finally {
    aborts.delete(conversationId)
  }
}
