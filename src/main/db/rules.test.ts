// Exercises the actual toRule()/listRules()/insertRule() seam against a real
// (temp-file) better-sqlite3 database -- the seam store.test.ts's mocked '../db'
// module skips entirely, which is why the R1 action:'command' hardcoding bug
// shipped with a green unit suite. See .superpowers/sdd/task-6-report.md.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { PermissionRule } from '../../shared/types'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  }
}))

// getDb() memoizes its Database handle at module scope, so each test needs a
// fresh module instance to get a fresh (empty) database file.
async function freshDb(): Promise<typeof import('./index')> {
  vi.resetModules()
  userDataDir = mkdtempSync(join(tmpdir(), 'bearcode-db-test-'))
  return import('./index')
}

describe('permission_rules round-trip', () => {
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('preserves action across an insert/list round trip for both known actions', async () => {
    const { insertRule, listRules } = await freshDb()
    const editRule: PermissionRule = {
      id: randomUUID(),
      scope: 'global',
      action: 'edit',
      match: 'guarded/**',
      effect: 'ask',
      source: 'user'
    }
    const commandRule: PermissionRule = {
      id: randomUUID(),
      scope: 'global',
      action: 'command',
      match: 'git *',
      effect: 'allow',
      source: 'user'
    }
    insertRule(editRule)
    insertRule(commandRule)

    const rules = listRules()
    expect(rules.find((r) => r.id === editRule.id)?.action).toBe('edit')
    expect(rules.find((r) => r.id === commandRule.id)?.action).toBe('command')
  })

  it('filters out a row with an unknown action and warns instead of defaulting to command', async () => {
    const { listRules } = await freshDb()
    // Force getDb() to create the schema/file, then seed a row with an action
    // outside the known PermissionAction union directly via better-sqlite3 --
    // simulating a stored value that predates (or otherwise falls outside) the
    // typed insertRule() path.
    listRules()
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(join(userDataDir, 'bearcode.db'))
    raw
      .prepare(
        `INSERT INTO permission_rules (id, project_path, action, match, effect, created_at)
         VALUES (?, NULL, 'network', '*', 'ask', ?)`
      )
      .run(randomUUID(), Date.now())
    raw.close()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rules = listRules()
    expect(rules.every((r) => r.action === 'command' || r.action === 'edit')).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})
