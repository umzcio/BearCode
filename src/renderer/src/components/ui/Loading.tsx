export interface LoadingProps {
  label?: string
}

// The shared inline loading row (BUI LoadingState look): a 3x3 pixel grid
// whose chevron wavefront drives right, next to a shimmering label. Sized so
// mounting or unmounting it doesn't shift surrounding layout. The wavefront
// delays live in shared.css (`.loading-cell:nth-child(n)`).
export function Loading({ label = 'Loading…' }: LoadingProps): React.JSX.Element {
  return (
    <div className="loading-state">
      <span className="loading-grid" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} className="loading-cell" />
        ))}
      </span>
      <span className="loading-label">{label}</span>
    </div>
  )
}
