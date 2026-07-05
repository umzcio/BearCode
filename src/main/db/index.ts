// SQLite persistence, main process only. Schema follows spec section 4.1:
// conversations are append-only event streams; streaming blocks are stored
// merged (one row per closed block), never as deltas.
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  ConversationMeta,
  Event,
  PermissionAction,
  PermissionMode,
  PermissionRule
} from '../../shared/types'
import { getSettings } from '../settings'

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
    CREATE TABLE IF NOT EXISTS permission_rules (
      id TEXT PRIMARY KEY,
      project_path TEXT,          -- NULL = global scope
      action TEXT NOT NULL,       -- 'command' | 'edit'
      match TEXT NOT NULL,
      effect TEXT NOT NULL,       -- 'allow' | 'deny' | 'ask'
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_convo ON events(conversation_id, seq);
  `)
  // Additive column for the per-conversation permission mode (Bb1). SQLite
  // ALTER ADD COLUMN is idempotent-guarded by catching the "duplicate column"
  // error so existing DBs upgrade in place.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN permission_mode TEXT`)
  } catch {
    // column already exists
  }
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
      console.log(`[bearcode] db: cancelled zombie run in conversation ${row.convoId}`)
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
  permission_mode: string | null
}

function toMeta(row: ConversationRow, fallbackTitle?: string | null): ConversationMeta {
  return {
    id: row.id,
    projectPath: row.project_path || null,
    title: row.title ?? fallbackTitle ?? null,
    modelRef: row.model_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissionMode: (row.permission_mode as PermissionMode) ?? getSettings().defaultPermissionMode
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
    updated_at: now,
    permission_mode: null
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
    .prepare(`SELECT payload, created_at FROM events WHERE conversation_id = ? ORDER BY seq ASC`)
    .all(conversationId) as { payload: string; created_at: number }[]
  return rows.map((r) => {
    const event = JSON.parse(r.payload) as Event
    // Surface the row's created_at as the user message's timestamp (for the
    // hover time on the bubble), backfilling history that predates the field.
    if (event.type === 'user_message' && event.createdAt == null) {
      event.createdAt = r.created_at
    }
    return event
  })
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

// Like appendEvent, but if an event with this id already exists it updates that
// row's payload in place (keeping its seq) instead of inserting. Used for the
// resolved (approved/denied) command tool_call, whose id equals the pending
// tool_call's: in the live flow the pending row was never persisted so this
// inserts (identical to appendEvent); in the crash-resume flow (A2) the pending
// row WAS persisted by rehydratePausedRun, so this replaces it in place rather
// than colliding on the events.id primary key.
export function appendOrReplaceEvent(conversationId: string, event: Event): void {
  const database = getDb()
  const existing = database.prepare(`SELECT seq FROM events WHERE id = ?`).get(event.id) as
    { seq: number } | undefined
  if (existing) {
    database
      .prepare(`UPDATE events SET type = ?, payload = ? WHERE id = ?`)
      .run(event.type, JSON.stringify(event), event.id)
    database
      .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), conversationId)
    return
  }
  appendEvent(conversationId, event)
}

// Remove the provisional synthetic 'Cancelled' event that cancelZombieRuns
// appends at boot, for a conversation the orchestrator is about to crash-resume
// (A2). Deletes the conversation's last event iff it is an 'error' whose message
// is 'Cancelled' -- the exact shape cancelZombieRuns writes -- so a real
// user-facing error is never removed. Callers only invoke this for confirmed
// resumable conversations from the authoritative getZombieRunIds() list.
export function dropDanglingCancel(conversationId: string): void {
  const database = getDb()
  const row = database
    .prepare(`SELECT id, payload FROM events WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(conversationId) as { id: string; payload: string } | undefined
  if (!row) return
  try {
    const ev = JSON.parse(row.payload) as Event
    if (ev.type === 'error' && ev.message === 'Cancelled') {
      database.prepare(`DELETE FROM events WHERE id = ?`).run(row.id)
    }
  } catch {
    // malformed payload -- leave it alone
  }
}

// Remove stale approval-lifecycle rows before crash-resume re-surfaces fresh
// cards (rehydratePausedRun). The interrupts are still checkpointed -- nothing
// was dispatched, so nothing executed -- but the events table can hold rows
// from the interrupted approval window: 'pending' tool_calls persisted by an
// earlier rehydrate, and 'approved'/'denied' tool_calls persisted at dispatch
// time whose command never produced a tool_result before the crash. Rehydrate
// mints fresh event ids for the re-surfaced cards, so leaving these rows in
// place would show the same logical approval twice (a stale "Ran cmd" or
// "Denied cmd" above a live pending card). Walks the conversation's trailing
// events and deletes exactly those rows, stopping at the first event that is
// settled history: any non-tool_call event, an 'auto' tool_call, or a resolved
// approval whose tool_result exists (that command really ran).
export function dropDanglingApprovalRows(conversationId: string): void {
  const database = getDb()
  const rows = database
    .prepare(`SELECT id, payload FROM events WHERE conversation_id = ? ORDER BY seq DESC`)
    .all(conversationId) as { id: string; payload: string }[]
  const resultCallIds = new Set<string>()
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.payload) as Event
      if (ev.type === 'tool_result') resultCallIds.add(ev.callId)
    } catch {
      // malformed payload -- it can't be an approval row; the scan below stops on it
    }
  }
  const del = database.prepare(`DELETE FROM events WHERE id = ?`)
  for (const row of rows) {
    let ev: Event
    try {
      ev = JSON.parse(row.payload) as Event
    } catch {
      break
    }
    if (ev.type !== 'tool_call') break
    const stale =
      ev.approvalState === 'pending' ||
      ((ev.approvalState === 'approved' || ev.approvalState === 'denied') &&
        !resultCallIds.has(ev.id))
    if (!stale) break
    del.run(row.id)
  }
}

export function setTitle(conversationId: string, title: string): void {
  getDb().prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, conversationId)
}

export function setModelRef(conversationId: string, modelRef: string): void {
  getDb()
    .prepare(`UPDATE conversations SET model_ref = ?, updated_at = ? WHERE id = ?`)
    .run(modelRef, Date.now(), conversationId)
}

export function setPermissionMode(conversationId: string, mode: PermissionMode): void {
  getDb()
    .prepare(`UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?`)
    .run(mode, Date.now(), conversationId)
}

export interface RuleRow {
  id: string
  project_path: string | null
  action: string
  match: string
  effect: string
}

// Maps a stored action string to the known PermissionAction union, or null if
// the row holds a value neither insertRule nor addUserRule would ever write.
// Falling back to 'command' here would silently turn a stray 'edit' deny into
// a command rule that matches nothing -- inert, and indistinguishable from
// R1 (the bug this guards against). Filtering the row out and warning is
// louder and safer: a future unknown action type never masquerades as a rule
// it is not. Exported (pure, no DB handle) so rules.test.ts can pin the
// mapping without loading better-sqlite3's native binding, which is built for
// Electron's ABI and cannot load under plain-Node vitest.
export function toRule(row: RuleRow): PermissionRule | null {
  if (row.action !== 'command' && row.action !== 'edit') {
    console.warn(
      `[bearcode] db: permission_rules row ${row.id} has unknown action "${row.action}"; skipping`
    )
    return null
  }
  return {
    id: row.id,
    scope: row.project_path == null ? 'global' : { projectPath: row.project_path },
    action: row.action as PermissionAction,
    match: row.match,
    effect: row.effect as PermissionRule['effect'],
    source: 'user'
  }
}

export function insertRule(rule: PermissionRule): void {
  const projectPath = rule.scope === 'global' ? null : rule.scope.projectPath
  getDb()
    .prepare(
      `INSERT INTO permission_rules (id, project_path, action, match, effect, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(rule.id, projectPath, rule.action, rule.match, rule.effect, Date.now())
}

export function listRules(): PermissionRule[] {
  const rows = getDb()
    .prepare(`SELECT id, project_path, action, match, effect FROM permission_rules`)
    .all() as RuleRow[]
  return rows.map(toRule).filter((r): r is PermissionRule => r !== null)
}

export function deleteRule(id: string): void {
  getDb().prepare(`DELETE FROM permission_rules WHERE id = ?`).run(id)
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
