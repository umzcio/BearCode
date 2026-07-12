export interface ErrorCardProps {
  children: React.ReactNode
}

// The shared styled alert box (generalizes the `domain-empty[role="alert"]`
// forks in Settings pages/modals -- a plain empty-state div reused for error
// copy). `role="alert"` so screen readers announce it on mount.
export function ErrorCard({ children }: ErrorCardProps): React.JSX.Element {
  return (
    <div className="ui-error-card" role="alert">
      {children}
    </div>
  )
}
