import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'

// Styled identically to TrustBanner/OutsideAccessCard -- reuses the shared
// .trust-banner class rather than introducing a new banner style.
export function UpdateBanner(): React.JSX.Element | null {
  const status = useAppStore((s) => s.updaterStatus)
  const dismissed = useAppStore((s) => s.updateBannerDismissed)
  const install = useAppStore((s) => s.installUpdate)
  const dismiss = useAppStore((s) => s.dismissUpdateBanner)
  // durationMs must match .trust-banner's own CSS transition duration
  // (--dur-fast, App.css) -- matches TrustBanner.tsx/ImportConfigBanner.tsx's
  // identical wiring for the same shared CSS class.
  const { mounted, state } = useAnimatedUnmount(status.state === 'ready' && !dismissed, {
    durationMs: 150
  })
  if (!mounted) return null
  return (
    <div className="trust-banner" data-state={state} role="alert">
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
