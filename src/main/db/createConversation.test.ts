// D4 draft-id flow: createConversation now accepts an optional id so Home's
// composer can create the conversation AS the client-minted draft id that
// Media attachments were already picked under (store.ts ensureDraftConvoId).
// better-sqlite3's native binding is compiled for Electron's ABI and cannot
// load under plain-Node vitest, so both 'electron' and 'better-sqlite3' are
// mocked at module level (same precedent as rules.test.ts/artifacts.test.ts),
// this time with a working fake Database so getDb()'s schema exec + the
// INSERT actually run against recorded calls instead of a real file.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))

const statement = { run: vi.fn(), all: vi.fn(() => []), get: vi.fn() }
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn(() => statement)
    }
  })
}))

import { createConversation } from './index'

describe('createConversation', () => {
  it('uses a supplied id instead of minting a random one', () => {
    const meta = createConversation(null, 'draft-abc-123')
    expect(meta.id).toBe('draft-abc-123')
    expect(statement.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-abc-123' }))
  })

  it('mints a random id when none is supplied (backward-compatible default)', () => {
    const meta = createConversation(null)
    expect(typeof meta.id).toBe('string')
    expect(meta.id).not.toBe('draft-abc-123')
    expect(meta.id.length).toBeGreaterThan(0)
  })
})
