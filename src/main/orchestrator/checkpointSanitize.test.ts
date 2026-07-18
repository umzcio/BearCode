import { describe, it, expect } from 'vitest'
import { repairPoisonedToolUseBlocks, sanitizeCheckpointMessages } from './checkpointSanitize'

describe('repairPoisonedToolUseBlocks', () => {
  it('merges an unmerged input_json_delta back into its tool_use block and drops the delta', () => {
    const content = [
      { type: 'text', text: 'Let me take a look.' },
      {
        index: 1,
        type: 'tool_use',
        id: 'toolu_01LyxPLY7QsTN4HPFS9Da8Eh',
        name: 'read_file',
        input: '',
        caller: { type: 'direct' }
      },
      { index: 1, input: '{"file_path": "/index.html", "offset": 0, "limit": 60}', type: 'input_json_delta' }
    ]
    const repaired = repairPoisonedToolUseBlocks(content)
    expect(repaired).toEqual([
      { type: 'text', text: 'Let me take a look.' },
      {
        index: 1,
        type: 'tool_use',
        id: 'toolu_01LyxPLY7QsTN4HPFS9Da8Eh',
        name: 'read_file',
        input: '{"file_path": "/index.html", "offset": 0, "limit": 60}',
        caller: { type: 'direct' }
      }
    ])
  })

  it('concatenates multiple deltas for the same index in order', () => {
    const content = [
      { index: 0, type: 'tool_use', id: 't1', name: 'run_command', input: '' },
      { index: 0, input: '{"command": ', type: 'input_json_delta' },
      { index: 0, input: '"open ursa.html"}', type: 'input_json_delta' }
    ]
    const repaired = repairPoisonedToolUseBlocks(content)
    expect(repaired).toEqual([
      { index: 0, type: 'tool_use', id: 't1', name: 'run_command', input: '{"command": "open ursa.html"}' }
    ])
  })

  it('is a no-op for clean content (returns the same array reference)', () => {
    const content = [{ type: 'text', text: 'hello' }]
    expect(repairPoisonedToolUseBlocks(content)).toBe(content)
  })

  it('never touches a tool_use block whose input is already non-empty', () => {
    const content = [
      { index: 0, type: 'tool_use', id: 't1', name: 'ls', input: '{"path": "/"}' },
      { index: 1, input: '{"unrelated": true}', type: 'input_json_delta' }
    ]
    const repaired = repairPoisonedToolUseBlocks(content)
    expect(repaired).toEqual([{ index: 0, type: 'tool_use', id: 't1', name: 'ls', input: '{"path": "/"}' }])
  })
})

describe('sanitizeCheckpointMessages', () => {
  it('repairs every poisoned AIMessage in channel_values.messages', () => {
    const channelValues = {
      messages: [
        { content: 'Hello Ursa' },
        {
          content: [
            { index: 0, type: 'tool_use', id: 't1', name: 'ls', input: '' },
            { index: 0, input: '{"path": "/"}', type: 'input_json_delta' }
          ]
        }
      ]
    }
    sanitizeCheckpointMessages(channelValues)
    expect(channelValues.messages[1].content).toEqual([
      { index: 0, type: 'tool_use', id: 't1', name: 'ls', input: '{"path": "/"}' }
    ])
  })

  it('is a no-op when channel_values or messages is missing/malformed', () => {
    expect(() => sanitizeCheckpointMessages(undefined)).not.toThrow()
    expect(() => sanitizeCheckpointMessages({})).not.toThrow()
    expect(() => sanitizeCheckpointMessages({ messages: 'not an array' })).not.toThrow()
  })
})
