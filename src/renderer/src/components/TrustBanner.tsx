import { useAppStore } from '../state/store'

export function TrustBanner(): React.JSX.Element | null {
  const workspacePath = useAppStore((s) => s.workspacePath)
  const trusted = useAppStore((s) => s.workspaceTrusted)
  const hasConfig = useAppStore((s) => s.workspaceHasAgentsConfig)
  const dismissed = useAppStore((s) => s.trustBannerDismissed)
  const trustWorkspace = useAppStore((s) => s.trustWorkspace)
  const dismiss = useAppStore((s) => s.dismissTrustBanner)
  if (!workspacePath || trusted || !hasConfig || dismissed) return null
  return (
    <div className="trust-banner" role="alert">
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
