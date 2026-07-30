import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { mergeAuxEvent, projectAuxEvents } from './auxEvents'

type ToolCallEvent = Extract<Event, { type: 'tool_call' }>

const userMessage = (id: string, text = 'Please make this change'): Event => ({
  type: 'user_message',
  id,
  text
})

const artifact = (id: string, status: 'pending-review' | 'approved' = 'pending-review'): Event => ({
  type: 'artifact',
  id,
  artifactId: `artifact-${id}`,
  artifactType: 'plan',
  version: 1,
  title: 'Plan',
  status,
  body: '# Plan'
})

const diff = (id: string): Event => ({
  type: 'file_diff',
  id,
  diffId: `diff-${id}`,
  files: [{ path: 'src/app.ts', additions: 2, deletions: 1, status: 'modified' }]
})

const attachment = (id: string): Event =>
  ({
    type: 'assistant_attachment',
    id,
    attachment: {
      id: `attachment-${id}`,
      name: 'report.pdf',
      mime: 'application/pdf',
      sizeBytes: 42
    }
  }) as Event

const toolCall = (
  id: string,
  tool: ToolCallEvent['tool'],
  approvalState: ToolCallEvent['approvalState'] = 'pending'
): Event => ({
  type: 'tool_call',
  id,
  tool,
  input: {},
  approvalState
})

describe('projectAuxEvents', () => {
  it('projects exactly the five pane event classes in source order', () => {
    const events: Event[] = [
      { type: 'assistant_text', id: 'text-1', text: 'Working' },
      userMessage('user-1'),
      toolCall('tool-noise', 'read_file'),
      artifact('artifact-1'),
      diff('diff-1'),
      attachment('attachment-1'),
      toolCall('submit-1', 'submit_plan'),
      { type: 'thinking', id: 'thinking-1', text: 'Done', durationMs: 20 }
    ]

    expect(projectAuxEvents(events).map((event) => event.id)).toEqual([
      'user-1',
      'artifact-1',
      'diff-1',
      'attachment-1',
      'submit-1'
    ])
  })
})

describe('mergeAuxEvent', () => {
  it('appends every projected event class in arrival order', () => {
    const events = [
      userMessage('user-1'),
      artifact('artifact-1'),
      diff('diff-1'),
      attachment('attachment-1'),
      toolCall('submit-1', 'submit_plan')
    ]

    const projected = events.reduce(mergeAuxEvent, projectAuxEvents([]))

    expect(projected.map((event) => event.id)).toEqual([
      'user-1',
      'artifact-1',
      'diff-1',
      'attachment-1',
      'submit-1'
    ])
  })

  it('replaces a matching tail event while preserving earlier event identity', () => {
    const first = userMessage('user-1')
    const before = projectAuxEvents([first, artifact('artifact-1')])

    const after = mergeAuxEvent(before, artifact('artifact-1', 'approved'))

    expect(after).not.toBe(before)
    expect(after[0]).toBe(first)
    expect(after.map((event) => event.id)).toEqual(['user-1', 'artifact-1'])
    expect(after[1]).toMatchObject({ type: 'artifact', status: 'approved' })
  })

  it('replaces a re-emitted submit_plan call by id without changing its position', () => {
    const sibling = diff('diff-1')
    const before = projectAuxEvents([
      toolCall('submit-1', 'submit_plan', 'pending'),
      sibling,
      artifact('artifact-1')
    ])

    const after = mergeAuxEvent(before, toolCall('submit-1', 'submit_plan', 'approved'))

    expect(after).not.toBe(before)
    expect(after.map((event) => event.id)).toEqual(['submit-1', 'diff-1', 'artifact-1'])
    expect(after[0]).toMatchObject({ type: 'tool_call', approvalState: 'approved' })
    expect(after[1]).toBe(sibling)
    expect(after[2]).toBe(before[2])
  })

  it('preserves the projection reference for streamed assistant text', () => {
    const before = projectAuxEvents([userMessage('user-1'), artifact('artifact-1')])

    const after = mergeAuxEvent(before, {
      type: 'assistant_text',
      id: 'text-1',
      text: 'Still working'
    })

    expect(after).toBe(before)
  })

  it('preserves the projection reference for an unrelated tool call', () => {
    const before = projectAuxEvents([userMessage('user-1'), diff('diff-1')])

    const after = mergeAuxEvent(before, toolCall('tool-noise', 'read_file'))

    expect(after).toBe(before)
  })
})
