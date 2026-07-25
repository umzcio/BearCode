import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { DetectedSource } from '@shared/types'
import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'
import { EmptyState } from './ui/EmptyState'

const KIND_LABEL: Record<DetectedSource['kind'], string> = {
  rule: 'Import as Rule',
  workflow: 'Import as Workflow',
  skill: 'Import as Skill',
  unsupported: 'Not yet supported'
}

// Outer gate: mounted unconditionally in App (see ProjectSettingsModal for the
// established pattern) -- reads its own visibility from the store and drives
// its own exit animation, rather than App threading state/props in.
export function ImportConfigReviewModal(): JSX.Element | null {
  const importReviewOpen = useAppStore((s) => s.importReviewOpen)
  const candidates = useAppStore((s) => s.workspaceImportCandidates)
  const closeReview = useAppStore((s) => s.closeImportReview)
  const applySelection = useAppStore((s) => s.applyImportSelection)
  const { mounted, state } = useAnimatedUnmount(importReviewOpen)

  const importable = candidates.filter((c) => c.kind !== 'unsupported')
  const unsupported = candidates.filter((c) => c.kind === 'unsupported')

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(importable.map((c) => c.sourcePath))
  )
  const [importing, setImporting] = useState(false)
  const [summaryText, setSummaryText] = useState<string | null>(null)

  // Esc closes only this modal, not whatever else is open behind it. Intercept
  // in the CAPTURE phase and stop propagation, matching BrowseSmitheryModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeReview])

  if (!mounted) return null

  const toggle = (sourcePath: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourcePath)) next.delete(sourcePath)
      else next.add(sourcePath)
      return next
    })
  }

  const doImport = (): void => {
    setImporting(true)
    const selection = {
      rules: importable.filter((c) => c.kind === 'rule' && selected.has(c.sourcePath)).map((c) => c.sourcePath),
      workflows: importable
        .filter((c) => c.kind === 'workflow' && selected.has(c.sourcePath))
        .map((c) => c.sourcePath),
      skills: importable.filter((c) => c.kind === 'skill' && selected.has(c.sourcePath)).map((c) => c.sourcePath)
    }
    void applySelection(selection).then((summary) => {
      setImporting(false)
      setSummaryText(
        `Imported ${summary.rulesImported} rule(s), ${summary.workflowsImported} workflow(s), ${summary.skillsImported} skill(s).`
      )
    })
  }

  return createPortal(
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && closeReview()}
    >
      <div className="smithery-panel" data-state={state}>
        <div className="smithery-header">
          <div>
            <div className="page-title">Review &amp; Import</div>
            <div className="smithery-sub">
              {summaryText ?? 'Choose what to bring into BearCode.'}
            </div>
          </div>
          <button className="pill-btn" onClick={closeReview}>
            Close
          </button>
        </div>
        {candidates.length === 0 ? (
          <EmptyState title="Nothing detected" />
        ) : (
          <>
            {importable.map((c) => (
              <label key={c.sourcePath} className="set-row">
                <input
                  type="checkbox"
                  checked={selected.has(c.sourcePath)}
                  onChange={() => toggle(c.sourcePath)}
                />
                <div className="set-row-text">
                  <div className="set-row-title">{c.sourcePath}</div>
                  <div className="set-row-desc">{KIND_LABEL[c.kind]}</div>
                </div>
              </label>
            ))}
            {unsupported.map((c) => (
              <div className="set-row" key={c.sourcePath}>
                <div className="set-row-text">
                  <div className="set-row-title">{c.sourcePath}</div>
                  <div className="set-row-desc">{KIND_LABEL[c.kind]}</div>
                </div>
              </div>
            ))}
            <button
              className="pill-btn primary"
              disabled={selected.size === 0 || importing || summaryText !== null}
              onClick={doImport}
            >
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
