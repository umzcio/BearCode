// D4 draft-id flow: createConversation now accepts an optional id so Home's
// composer can create the conversation AS the client-minted draft id that
// Media attachments were already picked under (store.ts ensureDraftConvoId).
// better-sqlite3's native binding is compiled for Electron's ABI and cannot
// load under plain-Node vitest, so both 'electron' and 'better-sqlite3' are
// mocked at module level (same precedent as rules.test.ts/artifacts.test.ts),
// this time with a working fake Database so getDb()'s schema exec + the
// INSERT actually run against recorded calls instead of a real file.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))

// getSettings is mocked so the F9 "seed a new folder from newProjectDefaults"
// branch in createConversation can be driven per-test. vi.hoisted so the vi.fn
// exists when the hoisted vi.mock factory runs (avoids a TDZ ReferenceError).
const { getSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ defaultEffort: 'adaptive', defaultThinking: true }) as never)
}))
vi.mock('../settings', () => ({ getSettings }))

// prepared statements: `get` drives the getProjectSettings existence check.
let existingRow: unknown = undefined
const prepared: { sql: string; run: ReturnType<typeof vi.fn> }[] = []
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => {
        const stmt = { sql, run: vi.fn(), all: vi.fn(() => []), get: vi.fn(() => existingRow) }
        prepared.push(stmt)
        return stmt
      })
    }
  })
}))

import { createConversation } from './index'

const runsMatching = (re: RegExp): number =>
  prepared.filter((p) => re.test(p.sql)).reduce((n, p) => n + p.run.mock.calls.length, 0)

beforeEach(() => {
  prepared.length = 0
  existingRow = undefined
  getSettings.mockReturnValue({ defaultEffort: 'adaptive', defaultThinking: true } as never)
})

describe('createConversation', () => {
  it('uses a supplied id instead of minting a random one', () => {
    const meta = createConversation(null, 'draft-abc-123')
    expect(meta.id).toBe('draft-abc-123')
    const convoInsert = prepared.find((p) => /INSERT INTO conversations/.test(p.sql))
    expect(convoInsert!.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-abc-123' }))
  })

  it('mints a random id when none is supplied (backward-compatible default)', () => {
    const meta = createConversation(null)
    expect(typeof meta.id).toBe('string')
    expect(meta.id).not.toBe('draft-abc-123')
    expect(meta.id.length).toBeGreaterThan(0)
  })

  it('seeds a new folder from newProjectDefaults on first conversation', () => {
    getSettings.mockReturnValue({
      defaultEffort: 'adaptive',
      defaultThinking: true,
      newProjectDefaults: { color: '#d97757', defaultEffort: 'high' }
    } as never)
    existingRow = undefined // no project_settings row yet → seed fires
    createConversation('/Users/zach/repo')
    expect(runsMatching(/INSERT OR IGNORE INTO project_settings/)).toBe(1)
    expect(runsMatching(/UPDATE project_settings SET/)).toBe(1)
  })

  it('does NOT seed when the folder already has a settings row', () => {
    getSettings.mockReturnValue({
      defaultEffort: 'adaptive',
      defaultThinking: true,
      newProjectDefaults: { color: '#d97757' }
    } as never)
    existingRow = { path: '/Users/zach/repo', name: null } // row exists → skip seed
    createConversation('/Users/zach/repo')
    expect(runsMatching(/INSERT OR IGNORE INTO project_settings/)).toBe(0)
  })

  it('does NOT seed when no newProjectDefaults template is set', () => {
    createConversation('/Users/zach/repo')
    expect(runsMatching(/project_settings/)).toBe(0)
  })

  it('never seeds a folderless (null projectPath) conversation', () => {
    getSettings.mockReturnValue({
      defaultEffort: 'adaptive',
      defaultThinking: true,
      newProjectDefaults: { color: '#d97757' }
    } as never)
    createConversation(null)
    expect(runsMatching(/project_settings/)).toBe(0)
  })
})
