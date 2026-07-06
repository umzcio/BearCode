import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))

// getSettings must return known defaults for the NULL-resolution assertions.
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'high', defaultThinking: false })
}))

let row: Record<string, unknown> = {}
const statement = {
  run: vi.fn(),
  all: vi.fn(() => []),
  get: vi.fn(() => row)
}
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return { pragma: vi.fn(), exec: vi.fn(), prepare: vi.fn(() => statement) }
  })
}))

import { getConversationMeta, setEffort, setThinking } from './index'

describe('db effort/thinking', () => {
  it('resolves NULL columns to the settings defaults', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null
    }
    const meta = getConversationMeta('c1')
    expect(meta?.effort).toBe('high')       // from mocked defaultEffort
    expect(meta?.thinking).toBe(false)      // from mocked defaultThinking
  })
  it('reads stored column values', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: 'max', thinking: 1
    }
    const meta = getConversationMeta('c1')
    expect(meta?.effort).toBe('max')
    expect(meta?.thinking).toBe(true)
  })
  it('setEffort persists the effort string', () => {
    setEffort('c1', 'low')
    expect(statement.run).toHaveBeenCalledWith('low', expect.any(Number), 'c1')
  })
  it('setThinking persists 1/0', () => {
    setThinking('c1', true)
    expect(statement.run).toHaveBeenCalledWith(1, expect.any(Number), 'c1')
    setThinking('c1', false)
    expect(statement.run).toHaveBeenCalledWith(0, expect.any(Number), 'c1')
  })
})
