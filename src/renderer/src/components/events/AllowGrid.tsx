// Shared "always allow" choices grid, extracted from the markup duplicated
// across PendingCommand/PendingUnsandboxed/PendingMcpAction/
// PendingIntegrationAction (audit L-17). Each card still builds its own rule
// scope/match values and approveTool resume closure -- this component only
// owns the wrapper + button markup, one cell per {label, onClick}.
export interface AllowGridCell {
  key: string
  label: React.ReactNode
  onClick: () => void
}

export function AllowGrid({ cells }: { cells: AllowGridCell[] }): React.JSX.Element {
  return (
    <div className="allow-grid">
      {cells.map((cell) => (
        <button key={cell.key} className="allow-cell" onClick={cell.onClick}>
          {cell.label}
        </button>
      ))}
    </div>
  )
}
