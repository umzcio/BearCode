// SQLite persistence, main process only. Schema follows spec section 4.1:
// conversations are append-only event streams; streaming blocks are stored
// merged (one row per closed block), never as deltas.
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { ConversationMeta, Event } from '../../shared/types'

let db: Database.Database | null = null

// The conversation IDs `cancelZombieRuns` patched during this process's boot
// scan. Populated exactly once, the first time `getDb()` opens the database.
// `resumeInterruptedRuns` (src/main/orchestrator/index.ts) reads this via
// `getZombieRunIds()` to know which conversations were dangling -- that is
// the authoritative signal, not the wording of the synthetic event this
// function writes.
let zombieRunIds: string[] = []

function getDb(): Database.Database {
  if (db) return db
  db = new Database(join(app.getPath('userData'), 'bearcode.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT,
      model_ref TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS diffs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      path TEXT, before_text TEXT, after_text TEXT,
      state TEXT DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_events_convo ON events(conversation_id, seq);
  `)
  zombieRunIds = cancelZombieRuns(db)
  return db
}

// A conversation whose last event is not turn_meta or error was mid-run when
// the app quit. Mark it cancelled on boot so no zombie states survive.
// Returns the conversation IDs it patched, so callers that need to know
// which conversations were dangling (e.g. the crash-resume scan) don't have
// to re-derive that by matching the wording of the synthetic event below.
function cancelZombieRuns(database: Database.Database): string[] {
  const rows = database
    .prepare(
      `SELECT e.conversation_id AS convoId, e.type AS type, e.seq AS seq
       FROM events e
       JOIN (SELECT conversation_id, MAX(seq) AS maxSeq FROM events GROUP BY conversation_id) m
         ON e.conversation_id = m.conversation_id AND e.seq = m.maxSeq`
    )
    .all() as { convoId: string; type: string; seq: number }[]
  const insert = database.prepare(
    `INSERT INTO events (id, conversation_id, seq, type, payload, created_at)
     VALUES (?, ?, ?, 'error', ?, ?)`
  )
  const patched: string[] = []
  for (const row of rows) {
    if (row.type !== 'turn_meta' && row.type !== 'error') {
      const event: Event = {
        type: 'error',
        id: randomUUID(),
        message: 'Cancelled',
        recoverable: true
      }
      insert.run(event.id, row.convoId, row.seq + 1, JSON.stringify(event), Date.now())
      console.log(`[ursa] db: cancelled zombie run in conversation ${row.convoId}`)
      patched.push(row.convoId)
    }
  }
  return patched
}

// The authoritative list of conversation IDs the boot-time zombie scan
// patched (see `cancelZombieRuns` above). Ensures the scan has run (opening
// the database if this is the first call) and returns its result -- callers
// must not re-derive "was this dangling" by matching event contents.
export function getZombieRunIds(): string[] {
  getDb()
  return zombieRunIds
}

interface ConversationRow {
  id: string
  project_path: string
  title: string | null
  model_ref: string | null
  created_at: number
  updated_at: number
}

function toMeta(row: ConversationRow, fallbackTitle?: string | null): ConversationMeta {
  return {
    id: row.id,
    projectPath: row.project_path || null,
    title: row.title ?? fallbackTitle ?? null,
    modelRef: row.model_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createConversation(projectPath: string | null): ConversationMeta {
  const now = Date.now()
  const row: ConversationRow = {
    id: randomUUID(),
    project_path: projectPath ?? '',
    title: null,
    model_ref: null,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      `INSERT INTO conversations (id, project_path, title, model_ref, created_at, updated_at)
       VALUES (@id, @project_path, @title, @model_ref, @created_at, @updated_at)`
    )
    .run(row)
  return toMeta(row)
}

export function listConversations(): ConversationMeta[] {
  const rows = getDb()
    .prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`)
    .all() as ConversationRow[]
  // Fall back to the first user message when no generated title exists yet.
  const firstMsg = getDb().prepare(
    `SELECT payload FROM events WHERE conversation_id = ? AND type = 'user_message'
     ORDER BY seq ASC LIMIT 1`
  )
  return rows.map((row) => {
    let fallback: string | null = null
    if (!row.title) {
      const msg = firstMsg.get(row.id) as { payload: string } | undefined
      if (msg) {
        const text = (JSON.parse(msg.payload) as { text: string }).text
        fallback = text.length > 42 ? text.slice(0, 42) + '…' : text
      }
    }
    return toMeta(row, fallback)
  })
}

export function getConversationMeta(id: string): ConversationMeta | null {
  const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
    ConversationRow | undefined
  return row ? toMeta(row) : null
}

export function getEvents(conversationId: string): Event[] {
  const rows = getDb()
    .prepare(`SELECT payload FROM events WHERE conversation_id = ? ORDER BY seq ASC`)
    .all(conversationId) as { payload: string }[]
  return rows.map((r) => JSON.parse(r.payload) as Event)
}

export function appendEvent(conversationId: string, event: Event): void {
  const database = getDb()
  const next = database
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE conversation_id = ?`)
    .get(conversationId) as { seq: number }
  database
    .prepare(
      `INSERT INTO events (id, conversation_id, seq, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(event.id, conversationId, next.seq, event.type, JSON.stringify(event), Date.now())
  database
    .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
    .run(Date.now(), conversationId)
}

export function setTitle(conversationId: string, title: string): void {
  getDb().prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, conversationId)
}

export function setModelRef(conversationId: string, modelRef: string): void {
  getDb()
    .prepare(`UPDATE conversations SET model_ref = ?, updated_at = ? WHERE id = ?`)
    .run(modelRef, Date.now(), conversationId)
}

export function deleteConversation(id: string): void {
  getDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id)
}

export function clearAll(): void {
  const database = getDb()
  database.prepare(`DELETE FROM events`).run()
  database.prepare(`DELETE FROM diffs`).run()
  database.prepare(`DELETE FROM conversations`).run()
}
