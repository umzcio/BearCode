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
import { existsSync } from 'fs'
import { join } from 'path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { CheckpointListOptions, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import { sanitizeCheckpointMessages } from './checkpointSanitize'

// Repairs the "input_json_delta" checkpoint corruption (see
// checkpointSanitize.ts) transparently on every read, so conversations
// checkpointed before patches/@langchain+core+1.2.2.patch existed heal
// themselves the next time they're loaded -- no migration step, no direct
// sqlite surgery. The patch stops NEW poisoning; this repairs what's already
// on disk. A real SqliteSaver subclass (not composition) so this remains a
// legitimate BaseCheckpointSaver for any instanceof check LangGraph makes.
class SanitizingSqliteSaver extends SqliteSaver {
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config)
    if (tuple) sanitizeCheckpointMessages(tuple.checkpoint.channel_values)
    return tuple
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of super.list(config, options)) {
      sanitizeCheckpointMessages(tuple.checkpoint.channel_values)
      yield tuple
    }
  }
}

let instance: BaseCheckpointSaver | null = null

function checkpointsDbPath(): string {
  return join(app.getPath('userData'), 'checkpoints.db')
}

export function getCheckpointer(): BaseCheckpointSaver {
  if (!instance) {
    const base = SqliteSaver.fromConnString(checkpointsDbPath())
    instance = Object.setPrototypeOf(base, SanitizingSqliteSaver.prototype) as BaseCheckpointSaver
  }
  return instance
}

// Drop a conversation's execution-state checkpoints when its conversation is
// deleted, so `checkpoints.db` doesn't accumulate orphaned thread rows (thread
// id == conversationId, matching graph.ts's `configurable.thread_id`). Guarded
// so it never *creates* the store just to delete from it: a legacy-engine user
// who has never run the orchestrator has no checkpoints.db, and this is a no-op
// for them. Best-effort -- a missing thread or a transient lock must not block
// the primary conversation delete.
export async function pruneCheckpoints(conversationId: string): Promise<void> {
  if (!instance && !existsSync(checkpointsDbPath())) return
  try {
    await getCheckpointer().deleteThread(conversationId)
  } catch {
    // best-effort cleanup
  }
}
