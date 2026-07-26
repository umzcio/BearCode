import { useState } from 'react'
import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'

const TOOL_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

export function ImportConfigBanner(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.workspaceImportBannerVisible)
  const candidates = useAppStore((s) => s.workspaceImportCandidates)
  const dismiss = useAppStore((s) => s.dismissImportBanner)
  const openReview = useAppStore((s) => s.openImportReview)
  const [dismissing, setDismissing] = useState(false)
  const { mounted, state } = useAnimatedUnmount(visible && candidates.length > 0)
  if (!mounted) return null

  const tools = Array.from(new Set(candidates.map((c) => TOOL_LABEL[c.tool] ?? c.tool)))

  const handleDismiss = (): void => {
    if (dismissing) return
    setDismissing(true)
    void dismiss().finally(() => setDismissing(false))
  }

  return (
    <div className="trust-banner" data-state={state} role="alert">
      <span className="trust-banner-msg">
        This folder has existing agent config from {tools.join(', ')}. Import it into BearCode?
      </span>
      <span className="trust-banner-actions">
        <button className="pill-btn" disabled={dismissing} onClick={handleDismiss}>
          {dismissing ? 'Dismissing…' : 'Not now'}
        </button>
        <button className="pill-btn primary" onClick={openReview}>
          Review &amp; Import
        </button>
      </span>
    </div>
  )
}
