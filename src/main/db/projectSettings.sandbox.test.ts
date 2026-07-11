// Task 4 (Sandbox Mode plan): sandboxMode + sandboxAllowNetwork are per-project
// columns on project_settings. better-sqlite3's native binding can't load under
// plain-Node vitest (see createConversation.test.ts precedent), so 'electron'
// and 'better-sqlite3' are mocked at module level. Unlike the simpler generic
// statement-recording fake in projectSettings.test.ts, this fake actually
// persists rows keyed by path (a small in-memory table) so upsert-then-read
// round-trips are meaningfully exercised across the three scenarios below.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'adaptive', defaultThinking: true })
}))

type Row = Record<string, unknown>
const rows = new Map<string, Row>()

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: (...args: unknown[]) => {
          if (/INSERT OR IGNORE INTO project_settings/.test(sql)) {
            const path = args[0] as string
            if (!rows.has(path)) {
              rows.set(path, {
                path,
                name: null,
                color: null,
                icon: null,
                default_model_ref: null,
                default_effort: null,
                default_permission_mode: null,
                sandbox_mode: null,
                sandbox_allow_network: null
              })
            }
          } else if (/UPDATE project_settings SET/.test(sql)) {
            const setPart = /SET (.+) WHERE/.exec(sql)?.[1] ?? ''
            const cols = setPart.split(',').map((c) => c.trim().split('=')[0].trim())
            const path = args[args.length - 1] as string
            const row = rows.get(path) ?? { path }
            cols.forEach((col, i) => {
              row[col] = args[i]
            })
            rows.set(path, row)
          }
        },
        get: (...args: unknown[]) => {
          if (/SELECT \* FROM project_settings WHERE path/.test(sql)) {
            return rows.get(args[0] as string)
          }
          return undefined
        },
        all: () => Array.from(rows.values())
      }))
    }
  })
}))

import { upsertProjectSettings, getProjectSettings } from './index'

beforeEach(() => {
  rows.clear()
})

describe('project_settings sandbox columns', () => {
  const p = '/tmp/bearcode-sbx-proj'
  it('defaults to sandbox off / network off for an unseeded folder', () => {
    const f = getProjectSettings(p)
    expect(f?.sandboxMode ?? false).toBe(false)
    expect(f?.sandboxAllowNetwork ?? false).toBe(false)
  })
  it('persists sandboxMode and sandboxAllowNetwork', () => {
    upsertProjectSettings(p, { sandboxMode: true, sandboxAllowNetwork: true })
    const f = getProjectSettings(p)
    expect(f?.sandboxMode).toBe(true)
    expect(f?.sandboxAllowNetwork).toBe(true)
  })
  it('clears a boolean back to false', () => {
    upsertProjectSettings(p, { sandboxMode: true })
    upsertProjectSettings(p, { sandboxMode: false })
    expect(getProjectSettings(p)?.sandboxMode).toBe(false)
  })
})
