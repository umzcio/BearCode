// Pure helper for the auto-compaction marker (Task C1).
//
// The deepagents summarization middleware, when its trigger fires, stores a
// `_summarizationEvent { cutoffIndex, summaryMessage, filePath }` in the graph
// state via `Command.update` (verified: deepagents dist langsmith-*.js). The
// `cutoffIndex` is the number of oldest messages folded into the summary and
// only ever grows across a conversation. We surface each advance once as a
// `compaction` event.

/**
 * Decide whether the summarizer's cutoff advanced since the last marker.
 *
 * @param prevCutoff - the last summarizedCount we already surfaced, or `null`
 *   if no compaction marker has been emitted yet for this conversation.
 * @param curr - the current `_summarizationEvent` from graph state, or
 *   `undefined` when the middleware has not summarized (yet).
 * @returns `advanced` = true when `curr.cutoffIndex` is a number strictly
 *   greater than `prevCutoff ?? 0`; `summarizedCount` = `curr.cutoffIndex`
 *   (0 when not advanced).
 */
export function compactionAdvanced(
  prevCutoff: number | null,
  curr: { cutoffIndex: number } | undefined
): { advanced: boolean; summarizedCount: number } {
  const cutoff = curr?.cutoffIndex
  if (typeof cutoff !== 'number' || !Number.isFinite(cutoff)) {
    return { advanced: false, summarizedCount: 0 }
  }
  const baseline = prevCutoff ?? 0
  if (cutoff > baseline) {
    return { advanced: true, summarizedCount: cutoff }
  }
  return { advanced: false, summarizedCount: 0 }
}
