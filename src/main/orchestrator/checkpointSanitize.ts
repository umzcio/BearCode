// Repairs a specific @langchain/core content-block merge bug that shipped in
// v1.2.2 (fixed going forward by patches/@langchain+core+1.2.2.patch, but
// that patch only prevents NEW poisoning -- any conversation checkpointed
// before it was applied still has the malformed shape persisted forever
// unless repaired). This module is that repair, applied transparently on
// every checkpoint read so already-poisoned conversations heal themselves
// the next time they're loaded, with no migration step and no risk of
// touching the sqlite file directly.
//
// The bug: Anthropic streams tool-call arguments as `input_json_delta`
// content-block deltas. @langchain/core's merge logic matches a delta to its
// parent block by stripping a trailing "_delta" from the type name
// ("text_delta" -> "text", "thinking_delta" -> "thinking"), but Anthropic's
// tool-argument delta breaks that convention: it's named "input_json_delta",
// not "tool_use_delta". Stripping "_delta" naively yields "input_json",
// which never matches the parent "tool_use" block, so the delta never gets
// merged -- it's left as its own separate content-block entry, and the
// `tool_use` block's `input` stays `''`. Anthropic tolerates this shape when
// a conversation continues on an Anthropic model; OpenAI's stricter
// content-block validation rejects it outright ("400 Invalid value:
// 'input_json_delta'...").
interface DeltaBlock {
  type: 'input_json_delta'
  index: unknown
  input: string
}

interface ToolUseBlock {
  type: 'tool_use'
  index: unknown
  input: string
  [key: string]: unknown
}

function asDeltaBlock(block: unknown): DeltaBlock | null {
  if (block == null || typeof block !== 'object') return null
  const b = block as Record<string, unknown>
  if (b.type !== 'input_json_delta' || !('index' in b) || typeof b.input !== 'string') return null
  return b as unknown as DeltaBlock
}

function asEmptyToolUseBlock(block: unknown): ToolUseBlock | null {
  if (block == null || typeof block !== 'object') return null
  const b = block as Record<string, unknown>
  if (b.type !== 'tool_use' || !('index' in b) || b.input !== '') return null
  return b as unknown as ToolUseBlock
}

export function repairPoisonedToolUseBlocks(content: unknown[]): unknown[] {
  const deltaInputByIndex = new Map<unknown, string>()
  const deltaPositions = new Set<number>()

  content.forEach((block, i) => {
    const delta = asDeltaBlock(block)
    if (!delta) return
    const prev = deltaInputByIndex.get(delta.index) ?? ''
    deltaInputByIndex.set(delta.index, prev + delta.input)
    deltaPositions.add(i)
  })

  if (deltaPositions.size === 0) return content

  return content
    .filter((_, i) => !deltaPositions.has(i))
    .map((block) => {
      const toolUse = asEmptyToolUseBlock(block)
      if (!toolUse || !deltaInputByIndex.has(toolUse.index)) return block
      return { ...toolUse, input: deltaInputByIndex.get(toolUse.index) }
    })
}

// Mutates a checkpoint's `channel_values.messages` array in place, repairing
// any AIMessage whose `content` array contains the poisoned pattern. Safe to
// call on any checkpoint: a no-op unless the exact pattern is present.
export function sanitizeCheckpointMessages(channelValues: Record<string, unknown> | undefined): void {
  const messages = channelValues?.['messages']
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (msg == null || typeof msg !== 'object') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const repaired = repairPoisonedToolUseBlocks(content)
    if (repaired !== content) (msg as { content: unknown }).content = repaired
  }
}
