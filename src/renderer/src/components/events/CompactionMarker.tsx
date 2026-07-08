import './events.css'

// A subtle transcript divider marking where auto-compaction folded the oldest
// `summarizedCount` messages into a summary (see graph.ts / compaction.ts).
// Purely informational -- no animation, reduce-motion safe by construction.
export function CompactionMarker({
  summarizedCount
}: {
  summarizedCount: number
}): React.JSX.Element {
  const label =
    summarizedCount === 1
      ? 'Compacted 1 earlier message'
      : `Compacted ${summarizedCount} earlier messages`
  return (
    <div className="compaction-marker" role="separator" aria-label={label}>
      <span className="compaction-rule" aria-hidden="true" />
      <span className="compaction-label">{label}</span>
      <span className="compaction-rule" aria-hidden="true" />
    </div>
  )
}
