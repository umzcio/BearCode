import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
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

import { getConversationMeta, setHermesSessionId } from './index'

describe('db hermesSessionId', () => {
  it('resolves a NULL column to null', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, ursa_mode: null, hermes_session_id: null
    }
    const meta = getConversationMeta('c1')
    expect(meta?.hermesSessionId).toBeNull()
  })

  it('reads a stored session id back', () => {
    row = {
      id: 'c1', project_path: '', title: null, model_ref: 'hermes/agent',
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, ursa_mode: null,
      hermes_session_id: '11111111-1111-1111-1111-111111111111'
    }
    const meta = getConversationMeta('c1')
    expect(meta?.hermesSessionId).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('setHermesSessionId persists the id', () => {
    setHermesSessionId('c1', '22222222-2222-2222-2222-222222222222')
    expect(statement.run).toHaveBeenCalledWith(
      '22222222-2222-2222-2222-222222222222',
      expect.any(Number),
      'c1'
    )
  })
})
