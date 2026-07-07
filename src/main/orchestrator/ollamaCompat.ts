// Ollama provider compatibility.
//
// @langchain/ollama's convertToolMessageToOllama() throws
//   "Non string tool message content is not supported"
// for any ToolMessage whose `content` is not a plain string. Deep Agents'
// built-in file tools return content as an array (e.g. file lines), and its
// large-content middleware emits structured blocks -- so on the Ollama backend
// those tool results crash the whole turn. Anthropic (and Gemini) accept array
// content, so this normalization is scoped to Ollama and never touches those
// paths.
import { createMiddleware } from 'langchain'
import { ToolMessage, isToolMessage } from '@langchain/core/messages'

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

// Rewrites every ToolMessage with non-string content to a string, right before
// the model call. Added to createDeepAgent's extraMiddleware ONLY when the
// provider is Ollama.
export const ollamaToolContentMiddleware = createMiddleware({
  name: 'BearcodeOllamaToolContent',
  wrapModelCall: (request, handler) => {
    let changed = false
    const messages = request.messages.map((m) => {
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
    return handler(changed ? { ...request, messages } : request)
  }
})
