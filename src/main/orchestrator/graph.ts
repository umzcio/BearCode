// The orchestrator's streaming graph: a bare deep agent (no tools, no
// checkpointer yet, Tasks 6/7) whose token stream is bridged into BearCode's
// existing Event contract and RunSink, mirroring the legacy engine's
// upsert-by-id streaming pattern (src/main/ursa/run.ts).
import { randomUUID } from 'crypto'
import { createDeepAgent } from 'deepagents'
import type { AIMessageChunk } from '@langchain/core/messages'
import type { Event } from '../../shared/types'
import type { RunSink } from '../ursa/run'
import { appendEvent } from '../db'
import { parseModelRef } from '../ursa/providers/registry'
import { makeModel } from './models'
import { textDeltaEvent, thinkingDeltaEvent } from './bridge'

// The tuple shape yielded by `.stream(..., { streamMode: "messages", subgraphs: true })`
// with a single (non-array) streamMode: [namespace, [chunk, metadata]]. (The
// 3-tuple with a leading mode string only appears when streamMode is an array
// of multiple modes; verified against StreamOutputMap in
// @langchain/langgraph/dist/pregel/types.d.ts.)
type MessagesStreamChunk = [string[], [AIMessageChunk, Record<string, unknown>]]

// Pull the reasoning text out of a streamed content block. Two shapes are
// observed live from the deep agent stream:
//   1. A standardized `reasoning` block ({ type: "reasoning", reasoning }) —
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

export async function runGraph(opts: {
  conversationId: string
  userText: string
  modelRef: string
  sink: RunSink
  signal: AbortSignal
}): Promise<void> {
  const { conversationId, userText, modelRef, sink, signal } = opts
  const { provider: providerId, modelId } = parseModelRef(modelRef)
  const startedAt = Date.now()

  sink.setState(conversationId, 'running')
  const userEvent: Event = { type: 'user_message', id: randomUUID(), text: userText }
  sink.emit(conversationId, userEvent)
  appendEvent(conversationId, userEvent)

  const model = makeModel(modelRef)
  const agent = createDeepAgent({ model })

  const answerId = randomUUID()
  let answer = ''
  let thinkId = ''
  let think = ''
  let thinkStartedAt = 0
  let thinkEndedAt = 0

  // subgraphs:true is set per the verified API notes so subagent streams are
  // tagged by namespace; this task has no subagents, so every chunk is the main
  // agent and no agentId is attributed. Subagent attribution lands with the
  // multi-agent task. (The main graph's own model node namespaces as
  // "model_request:<id>", which is NOT a subagent and must not be labelled.)
  const stream = await agent.stream(
    { messages: [{ role: 'user', content: userText }] },
    {
      streamMode: 'messages',
      subgraphs: true,
      signal,
      configurable: { thread_id: conversationId }
    }
  )

  for await (const item of stream) {
    const [, [chunk]] = item as MessagesStreamChunk
    for (const block of chunk.contentBlocks ?? []) {
      const reasoning = reasoningTextOf(block)
      if (reasoning) {
        if (!thinkId) {
          thinkId = randomUUID()
          thinkStartedAt = Date.now()
        }
        think += reasoning
        sink.emit(conversationId, thinkingDeltaEvent(thinkId, think, Date.now() - thinkStartedAt))
      } else if (block.type === 'text' && block.text) {
        if (thinkId && !thinkEndedAt) thinkEndedAt = Date.now()
        answer += block.text
        sink.emit(conversationId, textDeltaEvent(answerId, answer))
      }
    }
  }

  // Persist merged blocks (same pattern as legacy run.ts: deltas stream live,
  // only the closed, merged block is written to the events table).
  if (thinkId && think) {
    appendEvent(
      conversationId,
      thinkingDeltaEvent(thinkId, think, (thinkEndedAt || Date.now()) - thinkStartedAt)
    )
  }
  if (answer) {
    appendEvent(conversationId, textDeltaEvent(answerId, answer))
  }

  const turnMeta: Event = {
    type: 'turn_meta',
    id: randomUUID(),
    provider: providerId,
    model: modelId,
    startedAt,
    endedAt: Date.now()
  }
  appendEvent(conversationId, turnMeta)
  sink.emit(conversationId, turnMeta)

  sink.setState(conversationId, signal.aborted ? 'cancelled' : 'done')
}
