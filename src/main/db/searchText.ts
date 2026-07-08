// Pure mapping from a persisted Event to the plain text it contributes to the
// full-text search index (F1 Conversation History), or null when the event is
// not searchable. Single source of truth for the search-scope decision:
// user + assistant prose + tool commands/output + edited file paths; NEVER
// thinking. Keep pure + unit-tested so scope changes touch only this file.
import type { Event } from '../../shared/types'

function clean(s: string): string | null {
  const t = s.trim()
  return t === '' ? null : t
}

export function extractSearchText(event: Event): string | null {
  switch (event.type) {
    case 'user_message':
    case 'assistant_text':
      return clean(event.text)
    case 'tool_call': {
      // tool name + every string value in the input (paths, patterns, commands)
      const parts: string[] = [event.tool]
      const walk = (v: unknown): void => {
        if (typeof v === 'string') parts.push(v)
        else if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') Object.values(v).forEach(walk)
      }
      walk(event.input)
      return clean(parts.join(' '))
    }
    case 'tool_result':
      return clean([event.output, event.stats?.path ?? ''].join(' '))
    default:
      return null
  }
}
