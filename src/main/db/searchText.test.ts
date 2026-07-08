import { describe, it, expect } from 'vitest'
import { extractSearchText } from './searchText'
import type { Event } from '../../shared/types'

const ev = (e: Partial<Event> & { type: Event['type'] }): Event => e as Event

describe('extractSearchText', () => {
  it('indexes user message text', () => {
    expect(
      extractSearchText(ev({ type: 'user_message', id: 'u', text: 'fox chicken grain' }))
    ).toBe('fox chicken grain')
  })
  it('indexes assistant answer text', () => {
    expect(
      extractSearchText(ev({ type: 'assistant_text', id: 'a', text: 'the farmer crosses' }))
    ).toBe('the farmer crosses')
  })
  it('indexes tool_call tool name + input incl. paths', () => {
    const out = extractSearchText(
      ev({
        type: 'tool_call',
        id: 't',
        tool: 'edit_file' as never,
        input: { path: 'src/registry.ts', pattern: 'gemini' },
        approvalState: 'approved' as never
      })
    )
    expect(out).toContain('edit_file')
    expect(out).toContain('src/registry.ts')
    expect(out).toContain('gemini')
  })
  it('indexes tool_result output and stats.path', () => {
    const out = extractSearchText(
      ev({
        type: 'tool_result',
        id: 'r',
        callId: 'c',
        output: 'npm build ok',
        durationMs: 1,
        truncated: false,
        stats: { path: 'dist/app.js', status: 'created', additions: 1, deletions: 0 }
      })
    )
    expect(out).toContain('npm build ok')
    expect(out).toContain('dist/app.js')
  })
  it('excludes thinking', () => {
    expect(
      extractSearchText(ev({ type: 'thinking', id: 'th', text: 'secret reasoning', durationMs: 1 }))
    ).toBeNull()
  })
  it('excludes turn_meta / file_diff / artifact / error / compaction', () => {
    expect(
      extractSearchText(
        ev({
          type: 'turn_meta',
          id: 'm',
          provider: 'anthropic',
          model: 'x',
          startedAt: 1,
          endedAt: 2
        })
      )
    ).toBeNull()
    expect(
      extractSearchText(ev({ type: 'error', id: 'e', message: 'boom', recoverable: true }))
    ).toBeNull()
    expect(extractSearchText(ev({ type: 'compaction', id: 'c', summarizedCount: 3 }))).toBeNull()
  })
  it('returns null for empty text so blank messages are not indexed', () => {
    expect(extractSearchText(ev({ type: 'user_message', id: 'u', text: '   ' }))).toBeNull()
  })
})
