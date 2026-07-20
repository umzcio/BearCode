import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))

// getSettings must return known defaults for the sibling effort/thinking
// resolution -- ursaMode has no settings-default fallback (unlike effort),
// so this only exists to keep toMeta happy for the other columns.
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

import { getConversationMeta, setUrsaMode } from './index'

describe('db ursaMode', () => {
  it('resolves a NULL column to auto', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, ursa_mode: null
    }
    const meta = getConversationMeta('c1')
    expect(meta?.ursaMode).toBe('auto')
  })
  it('coerces an unrecognized/garbage value to auto', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, ursa_mode: 'not-a-real-mode'
    }
    const meta = getConversationMeta('c1')
    expect(meta?.ursaMode).toBe('auto')
  })
  it('reads each stored mode value back', () => {
    for (const mode of ['auto', 'code', 'council', 'deep-research']) {
      row = {
        id: 'c1', project_path: '', title: null, model_ref: null,
        created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
        effort: null, thinking: null, ursa_mode: mode
      }
      const meta = getConversationMeta('c1')
      expect(meta?.ursaMode).toBe(mode)
    }
  })
  it('setUrsaMode persists the mode string', () => {
    setUrsaMode('c1', 'code')
    expect(statement.run).toHaveBeenCalledWith('code', expect.any(Number), 'c1')
  })
})
