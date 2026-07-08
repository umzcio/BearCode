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

// The user message a bare `/compact` turn (no trailing prose) sends to the
// agent. By the time the model runs, the forced summarizer has ALREADY
// attempted to fold the backlog inside this turn's model call. Two outcomes:
//   - It compacted: deepagents prepends a summary-framing message to the
//     model's context ("...a conversation that has been summarized... A
//     condensed summary follows: <summary>"). The agent restates it so the
//     user can confirm what was kept; closeOutTurn also emits the deterministic
//     "Compacted N earlier messages" marker.
//   - Nothing to compact (chat shorter than the keep window): no summary is
//     present. The agent must NOT claim a summary happened.
// The directive keys the reply off that in-context cue so the acknowledgement
// is honest either way — this is the fix for /compact falsely reporting
// "summarized" on a too-short conversation.
export const COMPACT_ACK_DIRECTIVE =
  'I asked to compact the earlier conversation to free up the context window. ' +
  'If your context now begins with a summary of the earlier conversation, ' +
  'briefly restate its key points so I can confirm what was kept, then wait ' +
  'for my next message. If there is no such summary, the conversation was too ' +
  'short to compact — reply only with "There wasn\'t enough earlier ' +
  'conversation to compact yet." and wait for my next message.'

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
