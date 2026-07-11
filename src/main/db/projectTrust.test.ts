// Task 1 (Project Trust plan): trust + outside-folder-access are per-project
// columns on project_settings. better-sqlite3's native binding can't load under
// plain-Node vitest, so 'electron' and 'better-sqlite3' are mocked at module
// level. Cloned from the persisting fake in projectSettings.sandbox.test.ts,
// extended with the five new trust/outside-access columns.
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
                sandbox_allow_network: null,
                trusted: null,
                outside_folder_access: null,
                outside_folder_allowed_paths: null,
                outside_folder_denied_paths: null,
                outside_folder_pending_paths: null
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
        get: (...args: unknown[]) =>
          /SELECT \* FROM project_settings WHERE path/.test(sql)
            ? rows.get(args[0] as string)
            : undefined,
        all: () => Array.from(rows.values())
      }))
    }
  })
}))

import {
  isProjectTrusted,
  trustProject,
  untrustProject,
  getOutsideFolderPolicy,
  setOutsideFolderPolicy,
  allowOutsidePath,
  denyOutsidePath,
  recordPendingOutsidePath,
  removeOutsidePath,
  listOutsidePaths,
  getProjectSettings
} from './index'

beforeEach(() => rows.clear())

describe('project trust + outside-access columns', () => {
  const p = '/tmp/bearcode-trust-proj'

  it('an unseeded folder is untrusted with policy ask (secure default)', () => {
    expect(isProjectTrusted(p)).toBe(false)
    expect(getOutsideFolderPolicy(p)).toBe('ask')
    expect(getProjectSettings(p)?.trusted ?? false).toBe(false)
  })

  it('trustProject / untrustProject flip the flag', () => {
    trustProject(p)
    expect(isProjectTrusted(p)).toBe(true)
    untrustProject(p)
    expect(isProjectTrusted(p)).toBe(false)
  })

  it('setOutsideFolderPolicy round-trips', () => {
    setOutsideFolderPolicy(p, 'deny')
    expect(getOutsideFolderPolicy(p)).toBe('deny')
  })

  it('allow moves a path out of denied+pending into allowed', () => {
    recordPendingOutsidePath(p, '/etc/hosts')
    denyOutsidePath(p, '/etc/hosts')
    allowOutsidePath(p, '/etc/hosts')
    const l = listOutsidePaths(p)
    expect(l.allowed).toContain('/etc/hosts')
    expect(l.denied).not.toContain('/etc/hosts')
    expect(l.pending).not.toContain('/etc/hosts')
  })

  it('recordPendingOutsidePath is idempotent', () => {
    recordPendingOutsidePath(p, '/a')
    recordPendingOutsidePath(p, '/a')
    expect(listOutsidePaths(p).pending).toEqual(['/a'])
  })

  it('removeOutsidePath drops a path from every list', () => {
    allowOutsidePath(p, '/x')
    removeOutsidePath(p, '/x')
    const l = listOutsidePaths(p)
    expect(l.allowed).not.toContain('/x')
  })
})
