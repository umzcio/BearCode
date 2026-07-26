// Terminal IPC validation (advisor plan 001): hasConversationForProject is the
// "has this app ever seen this folder path via a conversation" half of the
// known-project check used by bearcode:terminal:create. Same fake-better-sqlite3
// mocking idiom as createConversation.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))

const seededPaths = new Set<string>()
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        get: (path: string) =>
          /SELECT 1 FROM conversations WHERE project_path/.test(sql) && seededPaths.has(path)
            ? { 1: 1 }
            : undefined,
        run: vi.fn(),
        all: vi.fn(() => [])
      }))
    }
  })
}))

import { hasConversationForProject } from './index'

beforeEach(() => seededPaths.clear())

describe('hasConversationForProject', () => {
  it('returns false for a path with no conversations', () => {
    expect(hasConversationForProject('/proj/unknown')).toBe(false)
  })

  it('returns true once a conversation exists for the path', () => {
    seededPaths.add('/proj/known')
    expect(hasConversationForProject('/proj/known')).toBe(true)
  })
})
