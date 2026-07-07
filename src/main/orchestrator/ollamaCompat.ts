// Ollama provider compatibility.
//
// @langchain/ollama's convertToolMessageToOllama() throws
//   "Non string tool message content is not supported"
// for any ToolMessage whose `content` is not a plain string. Deep Agents'
// built-in file tools return content as an array (e.g. file lines), and its
// large-content middleware emits structured blocks -- so on the Ollama backend
// those tool results crash the turn. Anthropic and Gemini accept array content,
// so this normalization is scoped to the Ollama model and never touches them.
//
// We normalize at the MODEL instance (not a single agent middleware) because
// convertToOllamaMessages runs on EVERY call path -- the main agent loop,
// subagents, summarization, and title generation all invoke the same model.
// ChatOllama.convertToOllamaMessages is reached from _streamResponseChunks
// (which _generate also delegates to) and _streamChatModelEvents; overriding
// both to pre-flatten tool content covers every path.
import { ChatOllama } from '@langchain/ollama'
import { ToolMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages'

// Flatten any tool-result content shape to a single string: arrays of lines or
// content blocks join with newlines (block.text when present, else JSON), and
// bare objects/values stringify. Lossless enough for a model to read.
export function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text
          if (typeof text === 'string') return text
          return JSON.stringify(part)
        }
        return String(part)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}

// Rewrite every ToolMessage with non-string content to a string-content clone,
// preserving the identity fields the graph pairs on (tool_call_id above all).
export function normalizeToolMessages(messages: BaseMessage[]): BaseMessage[] {
  let changed = false
  const out = messages.map((m) => {
    if (isToolMessage(m) && typeof m.content !== 'string') {
      changed = true
      return new ToolMessage({
        content: stringifyToolContent(m.content),
        tool_call_id: m.tool_call_id,
        name: m.name,
        id: m.id,
        status: m.status,
        artifact: m.artifact
      })
    }
    return m
  })
  return changed ? out : messages
}

// ChatOllama that stringifies non-string tool-message content on the way to the
// wire. NOTE: overrides internal streaming methods -- if @langchain/ollama
// renames them the normalization silently no-ops (the original crash returns),
// so this pairs with the ollamaCompat tests as the tripwire.
export class BearcodeChatOllama extends ChatOllama {
  override _streamResponseChunks(
    messages: BaseMessage[],
    options: Parameters<ChatOllama['_streamResponseChunks']>[1],
    runManager?: Parameters<ChatOllama['_streamResponseChunks']>[2]
  ): ReturnType<ChatOllama['_streamResponseChunks']> {
    return super._streamResponseChunks(normalizeToolMessages(messages), options, runManager)
  }

  override _streamChatModelEvents(
    messages: BaseMessage[],
    options: Parameters<ChatOllama['_streamChatModelEvents']>[1],
    runManager?: Parameters<ChatOllama['_streamChatModelEvents']>[2]
  ): ReturnType<ChatOllama['_streamChatModelEvents']> {
    return super._streamChatModelEvents(normalizeToolMessages(messages), options, runManager)
  }
}
