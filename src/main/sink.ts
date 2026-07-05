// The engine -> renderer seam. An engine pushes Events, run-state changes, and
// conversation-meta updates through a RunSink; ipc.ts's implementation
// broadcasts each over the corresponding IPC channel. Kept provider- and
// engine-neutral so it outlived the deleted legacy engine (which originally defined
// it) and is shared by the orchestrator engine and the IPC layer.
import type { ConversationMeta, Event, RunState } from '../shared/types'

export interface RunSink {
  emit(conversationId: string, event: Event): void
  setState(conversationId: string, state: RunState): void
  metaChanged(meta: ConversationMeta): void
}
