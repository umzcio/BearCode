// Manual "Compact now" support. Because the summarizer runs INSIDE the turn's
// model call, we can't compact on demand between turns — instead a manual
// request lowers the summarizer's trigger for exactly ONE upcoming turn, so
// compaction fires on the user's next message (reusing the real summarizer;
// we never hand-mutate the checkpoint).
//
// This is a tiny process-global transient: in-memory only, one entry per
// conversation. Resetting on app restart is fine — a pending "compact next
// turn" flag has no meaning across restarts.
import type { CommandRef } from '../../shared/types'

const forced = new Set<string>()

// Mark a conversation to force-compact on its next model call.
export function markForceCompact(conversationId: string): void {
  forced.add(conversationId)
}

// One-shot: returns true (and clears the flag) if the conversation was marked.
export function consumeForceCompact(conversationId: string): boolean {
  return forced.delete(conversationId)
}

// Whether a sent command should force compaction on the turn it is invoked.
// The `/compact` builtin is the only one; runGraph calls markForceCompact when
// this is true, right before buildAgentAndContext consumes the flag. Pure —
// unit-tested so the send-path gate can't silently drift.
export function commandForcesCompact(command: CommandRef | null): boolean {
  return command?.kind === 'builtin' && command.name === 'compact'
}
