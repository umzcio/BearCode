import { useAppStore } from '../state/store'

// Styled identically to TrustBanner/OutsideAccessCard -- reuses the shared
// .trust-banner class rather than introducing a new banner style.
export function UpdateBanner(): React.JSX.Element | null {
  const status = useAppStore((s) => s.updaterStatus)
  const dismissed = useAppStore((s) => s.updateBannerDismissed)
  const install = useAppStore((s) => s.installUpdate)
  const dismiss = useAppStore((s) => s.dismissUpdateBanner)
  if (status.state !== 'ready' || dismissed) return null
  return (
    <div className="trust-banner" role="alert">
      <span className="trust-banner-msg">
        BearCode {status.version} is ready to install.
      </span>
      <span className="trust-banner-actions">
        <button className="pill-btn" onClick={dismiss}>
          Not now
        </button>
        <button className="pill-btn primary" onClick={install}>
          Restart &amp; Install
        </button>
      </span>
    </div>
  )
}
