// Diff staging (spec 6.2): write_file/edit_file never touch disk. Staged
// before/after pairs live in the diffs table; Accept in the review pane
// writes to disk, Reject discards.
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, relative } from 'path'
import { diffLines } from 'diff'
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { FileDiff, FileDiffFile } from '../../shared/types'
import { getConversationMeta } from '../db'

// Reuse the main database file; the diffs table gains a group_id column so
// one review card can carry several files staged in the same turn.
let db: Database.Database | null = null
function getDb(): Database.Database {
  if (db) return db
  db = new Database(join(app.getPath('userData'), 'bearcode.db'))
  db.exec(`CREATE TABLE IF NOT EXISTS diffs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    path TEXT, before_text TEXT, after_text TEXT,
    state TEXT DEFAULT 'pending'
  )`)
  try {
    db.exec(`ALTER TABLE diffs ADD COLUMN group_id TEXT`)
  } catch {
    /* column exists */
  }
  return db
}

export function countChanges(
  before: string,
  after: string
): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0
    else if (part.removed) deletions += part.count ?? 0
  }
  return { additions, deletions }
}

// Write-through (Antigravity model): the change lands on disk immediately
// and is recorded here so the user can review, comment on, or revert it.
export function stageFile(
  groupId: string,
  conversationId: string,
  absPath: string,
  beforeText: string,
  afterText: string
): FileDiffFile {
  const fileId = randomUUID()
  const status = beforeText === '' && !existsSync(absPath) ? 'created' : 'modified'
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, afterText)
  getDb()
    .prepare(
      `INSERT INTO diffs (id, conversation_id, path, before_text, after_text, state, group_id)
       VALUES (?, ?, ?, ?, ?, 'applied', ?)`
    )
    .run(fileId, conversationId, absPath, beforeText, afterText, groupId)
  console.log(`[ursa] change applied: ${absPath}`)
  const { additions, deletions } = countChanges(beforeText, afterText)
  return {
    fileId,
    path: absPath,
    status,
    beforeText,
    afterText,
    additions,
    deletions,
    state: 'applied'
  }
}

interface DiffRow {
  id: string
  conversation_id: string
  path: string
  before_text: string
  after_text: string
  // Older rows carry pending/accepted from the staged-diff era.
  state: 'pending' | 'accepted' | 'rejected' | 'applied'
  group_id: string
}

function rowToFile(row: DiffRow, projectPath: string | null): FileDiffFile {
  const { additions, deletions } = countChanges(row.before_text, row.after_text)
  return {
    fileId: row.id,
    path: projectPath ? relative(projectPath, row.path) : row.path,
    status: row.before_text === '' ? 'created' : 'modified',
    beforeText: row.before_text,
    afterText: row.after_text,
    additions,
    deletions,
    state: row.state === 'rejected' ? 'reverted' : 'applied'
  }
}

export function getDiff(groupId: string): FileDiff {
  const rows = getDb()
    .prepare(`SELECT * FROM diffs WHERE group_id = ? ORDER BY path`)
    .all(groupId) as DiffRow[]
  const projectPath = rows[0]
    ? (getConversationMeta(rows[0].conversation_id)?.projectPath ?? null)
    : null
  return { diffId: groupId, files: rows.map((r) => rowToFile(r, projectPath)) }
}

export function filePathFor(fileId: string): string | null {
  const row = getDb().prepare(`SELECT path FROM diffs WHERE id = ?`).get(fileId) as
    { path: string } | undefined
  return row?.path ?? null
}

// Undo an applied change: restore the before-state (or remove a created file).
export function revertFile(fileId: string): void {
  const row = getDb().prepare(`SELECT * FROM diffs WHERE id = ?`).get(fileId) as DiffRow | undefined
  if (!row || row.state === 'rejected') return
  if (row.before_text === '') {
    if (existsSync(row.path)) unlinkSync(row.path)
  } else {
    writeFileSync(row.path, row.before_text)
  }
  getDb().prepare(`UPDATE diffs SET state = 'rejected' WHERE id = ?`).run(fileId)
  console.log(`[ursa] change reverted: ${row.path}`)
}
