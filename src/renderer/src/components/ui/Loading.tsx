export interface LoadingProps {
  label?: string
}

// The shared inline loading row: a small spinner + label, sized so mounting
// or unmounting it doesn't shift surrounding layout.
export function Loading({ label = 'Loading…' }: LoadingProps): React.JSX.Element {
  return (
    <div className="loading-state">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
