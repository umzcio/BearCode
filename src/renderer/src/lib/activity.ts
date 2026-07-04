import type { Event } from '@shared/types'
import type { ConvoRunState } from '../state/store'

export type ActivityTone = 'busy' | 'attention'
export interface Activity {
  label: string
  tone: ActivityTone
}

const READ_TOOLS = new Set(['ls', 'list_dir', 'read_file', 'glob', 'grep', 'search_files'])

function findLast(events: Event[], pred: (e: Event) => boolean): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (pred(events[i])) return events[i]
  }
  return undefined
}

function strInput(input: unknown, key: string): string | null {
  if (typeof input === 'object' && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

function inflightLabel(tool: string, input: unknown): string {
  if (tool === 'run_command') {
    const cmd = strInput(input, 'command')
    if (!cmd) return 'Running a command…'
    return `Running: ${cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd}`
  }
  if (tool === 'write_file' || tool === 'edit_file') {
    // Deep Agents built-ins emit the path under either 'path' or 'file_path'
    // depending on the model, so check both (verified in persisted events).
    const path = strInput(input, 'path') ?? strInput(input, 'file_path')
    const name = path ? (path.split('/').pop() ?? path) : null
    return name ? `Writing ${name}…` : 'Writing a file…'
  }
  if (READ_TOOLS.has(tool)) return 'Reading…'
  return 'Working…'
}

// Pure: maps run state + the conversation's events to the status-line label.
// Only meaningfully called while running/awaiting-approval; safe otherwise.
export function deriveActivity(runState: ConvoRunState, events: Event[]): Activity {
  if (runState === 'awaiting-approval') {
    return { label: 'Waiting for your approval', tone: 'attention' }
  }
  const lastCall = findLast(events, (e) => e.type === 'tool_call')
  if (lastCall && lastCall.type === 'tool_call') {
    const done = events.some((e) => e.type === 'tool_result' && e.callId === lastCall.id)
    if (!done) return { label: inflightLabel(lastCall.tool, lastCall.input), tone: 'busy' }
  }
  const lastMeaningful = findLast(
    events,
    (e) => e.type === 'thinking' || e.type === 'tool_call' || e.type === 'tool_result'
  )
  if (lastMeaningful?.type === 'thinking') return { label: 'Thinking…', tone: 'busy' }
  return { label: 'Working…', tone: 'busy' }
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
