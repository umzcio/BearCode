// A SEPARATE persistence store from src/main/db/index.ts. The `events` table
// there stays the UI's source of truth (what the renderer replays into a
// conversation view); this file gives LangGraph its own durable store for the
// graph's execution state (messages, node cursor, pending writes) so a run
// can be resumed after a crash instead of only being replayed as text.
//
// Construction verified against the installed .d.ts (Task 1 ground truth,
// planning/replatform-api-notes.md section (e)):
//   node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.d.ts
//     static fromConnString(connStringOrLocalPath: string): SqliteSaver
// `fromConnString` is used (not `new SqliteSaver(db)`) so this module doesn't
// also need a direct `better-sqlite3` dependency just to open the file --
// the saver opens/creates the sqlite file and lazily runs its own table
// setup (`protected setup()`, called before every read/write) on first use.
import { app } from 'electron'
import { join } from 'path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import type { BaseCheckpointSaver } from '@langchain/langgraph'

let instance: BaseCheckpointSaver | null = null

export function getCheckpointer(): BaseCheckpointSaver {
  if (!instance) {
    const path = join(app.getPath('userData'), 'checkpoints.db')
    instance = SqliteSaver.fromConnString(path)
  }
  return instance
}
