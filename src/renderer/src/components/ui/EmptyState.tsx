export interface EmptyStateProps {
  title: string
  hint?: React.ReactNode
}

// The shared "nothing here yet" placeholder (generalizes the 6 forked
// `domain-empty` classes across Settings pages/modals). Left-aligned, muted
// title + an optional secondary "next step" hint line.
export function EmptyState({ title, hint }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {hint != null ? <div className="empty-state-hint">{hint}</div> : null}
    </div>
  )
}
