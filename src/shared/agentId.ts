import type { Event } from './types'

export function subagentLabel(event: Event): string | null {
  const id = 'agentId' in event ? event.agentId : undefined
  if (!id || id === 'main') return null
  return id
}
