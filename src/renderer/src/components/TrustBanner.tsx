import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'

export function TrustBanner(): React.JSX.Element | null {
  const workspacePath = useAppStore((s) => s.workspacePath)
  const trusted = useAppStore((s) => s.workspaceTrusted)
  const hasConfig = useAppStore((s) => s.workspaceHasAgentsConfig)
  const dismissed = useAppStore((s) => s.trustBannerDismissed)
  const trustWorkspace = useAppStore((s) => s.trustWorkspace)
  const dismiss = useAppStore((s) => s.dismissTrustBanner)
  // durationMs must match .trust-banner's own CSS transition duration
  // (--dur-fast, App.css) -- matches ImportConfigBanner.tsx's identical
  // wiring for the same shared CSS class.
  const { mounted, state } = useAnimatedUnmount(
    Boolean(workspacePath) && !trusted && hasConfig && !dismissed,
    { durationMs: 150 }
  )
  if (!mounted) return null
  return (
    <div className="trust-banner" data-state={state} role="alert">
      <span className="trust-banner-msg">
        This folder hasn&apos;t been trusted. Its project rules, skills, and memory won&apos;t load
        until you trust it.
      </span>
      <span className="trust-banner-actions">
        <button className="pill-btn" onClick={dismiss}>
          Not now
        </button>
        <button className="pill-btn primary" onClick={() => void trustWorkspace()}>
          Trust folder
        </button>
      </span>
    </div>
  )
}
