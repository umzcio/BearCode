// SQLite persistence, main process only. Schema follows spec section 4.1:
// conversations are append-only event streams; streaming blocks are stored
// merged (one row per closed block), never as deltas.
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  Artifact,
  ArtifactComment,
  ArtifactStatus,
  ArtifactType,
  ConversationMeta,
  EffortLevel,
  Event,
  PermissionAction,
  PermissionMode,
  PermissionRule,
  HistoryHit,
  Project
} from '../../shared/types'
import { getSettings } from '../settings'
import { extractSearchText } from './searchText'

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
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,        -- 'plan' | 'walkthrough'
      version INTEGER NOT NULL,  -- per conversation+type, starts 1
      title TEXT NOT NULL,
      body TEXT NOT NULL,        -- markdown
      status TEXT NOT NULL,      -- 'pending-review' | 'approved' | 'superseded' | 'final'
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS artifact_comments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
      quote TEXT,                -- plain-text anchor, the selected plan text
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER            -- NULL until delivered on Proceed/Review (Ba2)
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_convo ON artifacts(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_convo ON events(conversation_id, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(text, event_id UNINDEXED, conversation_id UNINDEXED, kind UNINDEXED);
  `)
  // Additive column for the per-conversation permission mode (Bb1). SQLite
  // ALTER ADD COLUMN is idempotent-guarded by catching the "duplicate column"
  // error so existing DBs upgrade in place.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN permission_mode TEXT`)
  } catch {
    // column already exists
  }
  // DEAD COLUMN (unified-mode-picker design §8): execution_mode is no longer
  // read or written. The unified PermissionMode absorbed the execution axis;
  // the column is kept only because SQLite column drops are disruptive. The
  // ALTER remains idempotent-guarded so old and new DBs share one schema, but
  // nothing in the app touches this column anymore.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN execution_mode TEXT`)
  } catch {
    // column already exists
  }
  // Additive column for the conversation's pinned Manual rules (D1 Task 5,
  // design 3.2): a JSON string[] of .agents rule names. Same
  // idempotent-guarded ALTER idiom as execution_mode above. NULL/malformed
  // reads resolve to [] in toMeta.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN active_rules TEXT`)
  } catch {
    // column already exists
  }
  // E6: per-conversation reasoning effort + thinking toggle. Same
  // idempotent-guarded ALTER idiom as active_rules above. NULL reads resolve to
  // the settings defaults in toMeta.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN effort TEXT`)
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN thinking INTEGER`)
  } catch {
    // column already exists
  }
  // E4: the project a conversation belongs to (NULL = unassigned). Same
  // idempotent-guarded ALTER idiom as effort/thinking above.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT`)
  } catch {
    // column already exists
  }
  // E7: pin/archive flags (NULL = false). Same idempotent-guarded ALTER idiom.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER`)
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER`)
  } catch {
    // column already exists
  }
  backfillEventFts(db)
  zombieRunIds = cancelZombieRuns(db)
  return db
}

// Full-text index row insert -- shared by the live-index path (appendEvent /
// appendOrReplaceEvent) and the one-time backfill. Inserts only when the event
// contributes searchable text (extractSearchText decides scope; thinking etc.
// return null and are never indexed).
function indexEvent(database: Database.Database, conversationId: string, event: Event): void {
  const txt = extractSearchText(event)
  if (txt == null) return
  database
    .prepare(`INSERT INTO event_fts (text, event_id, conversation_id, kind) VALUES (?, ?, ?, ?)`)
    .run(txt, event.id, conversationId, event.type)
}

// One-time, idempotent backfill of the FTS index for history that predates the
// live index (F1): if event_fts is empty while events is not, walk every event
// once and index it. Guarded so it runs at most once (later opens see a
// populated event_fts and return immediately); wrapped in a transaction; errors
// are logged and swallowed -- a failed backfill must never block app boot, it
// only degrades search over old messages until the next indexed write.
function backfillEventFts(database: Database.Database): void {
  try {
    const ftsCount = (
      database.prepare(`SELECT COUNT(*) AS n FROM event_fts`).get() as { n: number }
    ).n
    if (ftsCount > 0) return
    const evCount = (database.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n
    if (evCount === 0) return
    const rows = database.prepare(`SELECT conversation_id, payload FROM events`).all() as {
      conversation_id: string
      payload: string
    }[]
    database.transaction(() => {
      for (const row of rows) {
        try {
          const event = JSON.parse(row.payload) as Event
          indexEvent(database, row.conversation_id, event)
        } catch {
          // malformed payload -- skip this row, keep backfilling the rest
        }
      }
    })()
  } catch (e) {
    console.error('[bearcode] db: event_fts backfill failed (non-fatal)', e)
  }
}

// Last path segment for a conversation's project label, matching the renderer's
// convention (store.ts): the folder basename, or 'No folder' when unassigned.
function projectLabelFor(projectPath: string | null): string {
  if (!projectPath) return 'No folder'
  const parts = projectPath.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || projectPath
}

// Sanitize free-text into a safe FTS5 MATCH expression: keep only word tokens
// (letters/digits/underscore) and wrap each in double quotes so FTS operators
// and stray punctuation ('fox()', 'a AND b', 'foo:bar') can never be parsed as
// query syntax and throw. Multiple tokens are ANDed (implicit). Returns null
// when nothing searchable remains, so searchHistory short-circuits to [].
function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' ')
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
  active_rules: string | null
  effort: string | null
  thinking: number | null
  project_id: string | null
  pinned: number | null
  archived: number | null
}

// A malformed active_rules value (hand-edited DB, partial write) must never
// break conversation reads: parse failures resolve to [].
function parseActiveRules(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function toMeta(row: ConversationRow, fallbackTitle?: string | null): ConversationMeta {
  return {
    id: row.id,
    projectPath: row.project_path || null,
    title: row.title ?? fallbackTitle ?? null,
    modelRef: row.model_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissionMode: (row.permission_mode as PermissionMode) ?? getSettings().defaultPermissionMode,
    activeRules: parseActiveRules(row.active_rules),
    effort: (row.effort as EffortLevel) ?? getSettings().defaultEffort,
    thinking: row.thinking == null ? getSettings().defaultThinking : row.thinking === 1,
    projectId: row.project_id ?? null,
    pinned: row.pinned === 1,
    archived: row.archived === 1
  }
}

export function createConversation(projectPath: string | null, id?: string): ConversationMeta {
  const now = Date.now()
  const row: ConversationRow = {
    id: id ?? randomUUID(),
    project_path: projectPath ?? '',
    title: null,
    model_ref: null,
    created_at: now,
    updated_at: now,
    permission_mode: null,
    active_rules: null,
    effort: null,
    thinking: null,
    project_id: null,
    pinned: null,
    archived: null
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
  indexEvent(database, conversationId, event)
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
    // Keep the FTS index in step with the replaced payload: drop the old row
    // (if any) and re-index the new event under the same id.
    database.prepare(`DELETE FROM event_fts WHERE event_id = ?`).run(event.id)
    indexEvent(database, conversationId, event)
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

export function setEffort(conversationId: string, effort: EffortLevel): void {
  getDb()
    .prepare(`UPDATE conversations SET effort = ?, updated_at = ? WHERE id = ?`)
    .run(effort, Date.now(), conversationId)
}

export function setThinking(conversationId: string, thinking: boolean): void {
  getDb()
    .prepare(`UPDATE conversations SET thinking = ?, updated_at = ? WHERE id = ?`)
    .run(thinking ? 1 : 0, Date.now(), conversationId)
}

// Persist the conversation's pinned Manual rules (D1 Task 5). Same dumb
// column-update shape as setPermissionMode above; the value is a JSON string[]
// of rule names, read back through toMeta's guarded parse.
export function setActiveRules(conversationId: string, names: string[]): void {
  getDb()
    .prepare(`UPDATE conversations SET active_rules = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(names), Date.now(), conversationId)
}

export function listProjects(): Project[] {
  const rows = getDb().prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as {
    id: string
    name: string
    color: string | null
    created_at: number
    updated_at: number
  }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function createProject(name: string, color: string | null = null): Project {
  const now = Date.now()
  const project: Project = { id: randomUUID(), name, color, createdAt: now, updatedAt: now }
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(project.id, project.name, project.color, project.createdAt, project.updatedAt)
  return project
}

export function renameProject(id: string, name: string): void {
  getDb()
    .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
    .run(name, Date.now(), id)
}

// Unassign the project's conversations, then delete the project — one
// transaction so a conversation can never point at a deleted project id.
export function deleteProject(id: string): void {
  const database = getDb()
  database.transaction(() => {
    database
      .prepare(`UPDATE conversations SET project_id = NULL, updated_at = ? WHERE project_id = ?`)
      .run(Date.now(), id)
    database.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  })()
}

export function setConversationProject(conversationId: string, projectId: string | null): void {
  getDb()
    .prepare(`UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?`)
    .run(projectId, Date.now(), conversationId)
}

export function setPinned(conversationId: string, pinned: boolean): void {
  getDb()
    .prepare(`UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, Date.now(), conversationId)
}

export function setArchived(conversationId: string, archived: boolean): void {
  getDb()
    .prepare(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?`)
    .run(archived ? 1 : 0, Date.now(), conversationId)
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

// One row of the touched-files query below: the two shapes a tool_call's
// input carries a path under (write_file/edit_file use file_path, read_file
// uses path). Exported pure so contextAssembly.test.ts can pin the
// dedupe/null-filter logic on hand-built rows without opening a database --
// same rationale as toRule above.
export interface TouchedFileRow {
  file_path: string | null
  path: string | null
}

// Deep Agents' built-in file tools (write_file/edit_file/read_file) supply
// input.file_path/input.path in three conventions: workspace-relative
// ('src/a.ts'), root-relative ('/src/a.ts'), and -- rarely -- a literal
// absolute OS path. matchesEditPath (permissions/rules.ts) only strips a
// leading './', so a stored root-relative path never matched a glob like
// 'src/**' before this normalization.
//
// Simplest honest rule: strip exactly ONE leading '/', turning the common
// root-relative convention into the workspace-relative form matchesEditPath
// expects. A genuine absolute OS path (e.g. '/Users/z/project/src/a.ts')
// also starts with '/' and gets the same treatment, which does NOT produce a
// workspace-relative path -- that case is deliberately left out of scope
// here. The write-time gate already resolves absolute paths against the
// project root via relForGate; storing a literal absolute path in a touched
// row is rare, and can be special-cased in a follow-up if it's seen in
// practice.
export function normalizeTouchedPath(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value
}

export function touchedFilesFromRows(rows: TouchedFileRow[]): string[] {
  const seen = new Set<string>()
  const files: string[] = []
  for (const row of rows) {
    for (const value of [row.file_path, row.path]) {
      if (value == null) continue
      const normalized = normalizeTouchedPath(value)
      if (!seen.has(normalized)) {
        seen.add(normalized)
        files.push(normalized)
      }
    }
  }
  return files
}

// Distinct file paths a conversation's persisted write_file/edit_file/
// read_file tool calls have touched (design 3.2's glob-activation input).
// json_extract reaches into the tool_call event's JSON payload directly so
// this stays a single query with no per-row JSON.parse.
export function touchedFilesFor(conversationId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(payload, '$.input.file_path') as file_path,
              json_extract(payload, '$.input.path') as path
       FROM events
       WHERE conversation_id = ?
         AND type = 'tool_call'
         AND json_extract(payload, '$.tool') IN ('write_file', 'edit_file', 'read_file')`
    )
    .all(conversationId) as TouchedFileRow[]
  return touchedFilesFromRows(rows)
}

export interface ArtifactRow {
  id: string
  conversation_id: string
  type: string
  version: number
  title: string
  body: string
  status: string
  created_at: number
  resolved_at: number | null
}

const ARTIFACT_TYPES: readonly string[] = ['plan', 'walkthrough']
const ARTIFACT_STATUSES: readonly string[] = ['pending-review', 'approved', 'superseded', 'final']

// toRule's posture (R1 guard): a row holding a type or status neither writer
// ever produces is filtered out loudly rather than coerced into something it
// is not. Exported (pure, no DB handle) so artifacts.test.ts can pin the
// mapping without loading better-sqlite3's native binding.
export function toArtifact(row: ArtifactRow): Artifact | null {
  if (!ARTIFACT_TYPES.includes(row.type) || !ARTIFACT_STATUSES.includes(row.status)) {
    console.warn(
      `[bearcode] db: artifacts row ${row.id} has unknown type/status "${row.type}"/"${row.status}"; skipping`
    )
    return null
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type as ArtifactType,
    version: row.version,
    title: row.title,
    body: row.body,
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

// INSERT OR IGNORE: artifact ids are derived deterministically from the
// provider tool-call id (tools.ts, Task 3), and a crash-rehydration replay can
// RE-EXECUTE a completed submit tool -- checkpoint durability is 'async' (the
// checkpointer promise is tracked, not awaited) and checkpoints.db shares no
// transaction with bearcode.db, so a crash between the tool completing and its
// task writes committing replays the task on resume. The authoritative replay
// guard is the store's getArtifact existence check (Task 2, which also skips
// re-supersede); OR IGNORE is belt-and-braces so a race can never throw on the
// primary key.
export function insertArtifact(a: Artifact): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO artifacts (id, conversation_id, type, version, title, body, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      a.id,
      a.conversationId,
      a.type,
      a.version,
      a.title,
      a.body,
      a.status,
      a.createdAt,
      a.resolvedAt
    )
}

export function getArtifact(id: string): Artifact | null {
  const row = getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    ArtifactRow | undefined
  return row ? toArtifact(row) : null
}

export function listArtifacts(conversationId: string): Artifact[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at ASC, version ASC`
    )
    .all(conversationId) as ArtifactRow[]
  return rows.map(toArtifact).filter((a): a is Artifact => a !== null)
}

// A new plan submission supersedes any STILL-PENDING prior plan in the same
// conversation (design 3.1). Scoped hard: type='plan' AND
// status='pending-review' only -- an 'approved' plan row is a historical
// record and is never rewritten; walkthroughs ('final') are never touched.
// Returns the flipped rows (with their new status) so the caller can re-emit
// each one's artifact event under its deterministic id -- Ba2's chip-unstale
// contract, superseding Ba1's point-in-time-chip limitation.
export function markPendingPlansSuperseded(conversationId: string, resolvedAt: number): Artifact[] {
  const database = getDb()
  const rows = database
    .prepare(
      `SELECT * FROM artifacts
       WHERE conversation_id = ? AND type = 'plan' AND status = 'pending-review'`
    )
    .all(conversationId) as ArtifactRow[]
  if (rows.length === 0) return []
  database
    .prepare(
      `UPDATE artifacts SET status = 'superseded', resolved_at = ?
       WHERE conversation_id = ? AND type = 'plan' AND status = 'pending-review'`
    )
    .run(resolvedAt, conversationId)
  return rows
    .map(toArtifact)
    .filter((a): a is Artifact => a !== null)
    .map((a) => ({ ...a, status: 'superseded' as const, resolvedAt }))
}

export interface ArtifactCommentRow {
  id: string
  artifact_id: string
  quote: string | null
  body: string
  created_at: number
  sent_at: number | null
}

// Pure verbatim map (no enum columns to guard). Exported for artifacts.test.ts.
export function toArtifactComment(row: ArtifactCommentRow): ArtifactComment {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    quote: row.quote,
    body: row.body,
    createdAt: row.created_at,
    sentAt: row.sent_at
  }
}

export function insertArtifactComment(c: ArtifactComment): void {
  getDb()
    .prepare(
      `INSERT INTO artifact_comments (id, artifact_id, quote, body, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(c.id, c.artifactId, c.quote, c.body, c.createdAt, c.sentAt)
}

export function listArtifactComments(artifactId: string): ArtifactComment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM artifact_comments WHERE artifact_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(artifactId) as ArtifactCommentRow[]
  return rows.map(toArtifactComment)
}

// Stamps delivery on every still-draft comment of one artifact (Proceed or
// Review composed them into the resolution). Sent comments are never restamped.
export function markArtifactCommentsSent(artifactId: string, sentAt: number): void {
  getDb()
    .prepare(`UPDATE artifact_comments SET sent_at = ? WHERE artifact_id = ? AND sent_at IS NULL`)
    .run(sentAt, artifactId)
}

// One artifact's status flip, returning the fresh row so the caller can
// re-emit its artifact event (the chip-unstale contract). No status-machine
// enforcement here -- the store layer (approvePlanArtifact) owns which
// transitions are legal.
export function updateArtifactStatus(
  id: string,
  status: ArtifactStatus,
  resolvedAt: number | null
): Artifact | null {
  getDb()
    .prepare(`UPDATE artifacts SET status = ?, resolved_at = ? WHERE id = ?`)
    .run(status, resolvedAt, id)
  return getArtifact(id)
}

export function deleteConversation(id: string): void {
  const database = getDb()
  // event_fts has no FK to conversations, so the ON DELETE CASCADE that clears
  // the events rows never touches it -- clear it explicitly first.
  database.prepare(`DELETE FROM event_fts WHERE conversation_id = ?`).run(id)
  database.prepare(`DELETE FROM conversations WHERE id = ?`).run(id)
}

export function clearAll(): void {
  const database = getDb()
  database.prepare(`DELETE FROM artifact_comments`).run()
  database.prepare(`DELETE FROM artifacts`).run()
  database.prepare(`DELETE FROM event_fts`).run()
  database.prepare(`DELETE FROM events`).run()
  database.prepare(`DELETE FROM diffs`).run()
  database.prepare(`DELETE FROM conversations`).run()
}

// Ranked full-text search across all conversations' indexed message content
// (F1). Sanitizes the query into a safe FTS5 expression (toFtsQuery), runs a
// bm25-ordered MATCH with a highlighted snippet, then joins each hit to its
// conversation's display meta -- dropping any hit whose conversation no longer
// exists (defense in depth beside deleteConversation's FTS cleanup). Thinking
// text is never in the index (extractSearchText), so it can never surface here.
export function searchHistory(query: string, limit = 50): HistoryHit[] {
  const term = toFtsQuery(query)
  if (term == null) return []
  const database = getDb()
  const rows = database
    .prepare(
      `SELECT f.event_id AS eventId, f.conversation_id AS conversationId, f.kind AS kind,
              snippet(event_fts, 0, '‹mark›', '‹/mark›', '…', 12) AS snippet
       FROM event_fts f WHERE event_fts MATCH ? ORDER BY bm25(event_fts) LIMIT ?`
    )
    .all(term, limit) as {
    eventId: string
    conversationId: string
    kind: string
    snippet: string
  }[]
  const metaStmt = database.prepare(`SELECT * FROM conversations WHERE id = ?`)
  const hits: HistoryHit[] = []
  for (const r of rows) {
    const convo = metaStmt.get(r.conversationId) as ConversationRow | undefined
    if (!convo) continue
    hits.push({
      conversationId: r.conversationId,
      eventId: r.eventId,
      kind: r.kind as Event['type'],
      snippet: r.snippet,
      title: convo.title,
      projectLabel: projectLabelFor(convo.project_path),
      updatedAt: convo.updated_at
    })
  }
  return hits
}
