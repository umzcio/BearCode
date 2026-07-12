import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import { IconClose } from '../icons'

// Scaffold only (Task 10 of the plugins arc). PluginsPage's "Browse Catalog"
// button needs somewhere to mount; the full catalog/add-marketplace/
// install-from-URL/review-card flow is built out in Task 11, which replaces
// this file's body wholesale. This shell just proves the open/close wiring
// (mirrors BrowseSmitheryModal's portal + capture-phase Escape handling).
interface Props {
  onClose: () => void
  onInstalled: () => void
}

export function BrowsePluginsModal({ onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="smithery-panel">
        <div className="smithery-header">
          <div>
            <div className="page-title">Browse Plugin Catalog</div>
            <div className="page-sub">Marketplace browsing lands in the next arc task.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
