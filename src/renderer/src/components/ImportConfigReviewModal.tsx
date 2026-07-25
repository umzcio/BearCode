import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { ImportCandidate } from '@shared/types'
import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'
import { EmptyState } from './ui/EmptyState'

const KIND_LABEL: Record<ImportCandidate['kind'], string> = {
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

  // Three buckets, not two (final review Finding 6): a source can be a
  // recognized kind and still fail to translate (an empty CLAUDE.md, a
  // non-kebab-case command filename, a SKILL.md missing its required
  // `description`). Those used to render pre-checked and importable, then
  // import as 0 items with no explanation -- they are now shown, disabled,
  // with a reason, and can never enter the selection.
  const importable = candidates.filter((c) => c.kind !== 'unsupported' && c.buildable)
  const skipped = candidates.filter((c) => c.kind !== 'unsupported' && !c.buildable)
  const unsupported = candidates.filter((c) => c.kind === 'unsupported')

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(importable.map((c) => c.sourcePath))
  )
  const [importing, setImporting] = useState(false)
  const [summaryText, setSummaryText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Esc closes only this modal, not whatever else is open behind it. Intercept
  // in the CAPTURE phase and stop propagation, matching BrowseSmitheryModal.
  // Unlike BrowseSmitheryModal (freshly mounted only while open), this
  // component is a permanent singleton (see the outer-gate note above), so
  // the listener must be gated on `importReviewOpen` itself -- otherwise it
  // stays registered for the app's entire lifetime and swallows every Escape
  // keypress everywhere (e.g. it silently blocked SettingsModal's own Escape
  // handler from ever firing while this modal was closed).
  useEffect(() => {
    if (!importReviewOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [importReviewOpen, closeReview])

  // This component is mounted once for the app's lifetime (see the outer-gate
  // note above) -- it is never truly unmounted/remounted by App, so the
  // `useState` lazy initializers below only ever run once, at true first
  // mount. Re-derive the per-open local state every time the modal transitions
  // to open, so a stale selection/summary from a prior open doesn't leak into
  // the next one.
  useEffect(() => {
    if (importReviewOpen) {
      setSelected(new Set(importable.map((c) => c.sourcePath)))
      setSummaryText(null)
      setError(null)
      setImporting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives only on open, not on every `importable`/`candidates` change while already open
  }, [importReviewOpen])

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
    setError(null)
    const selection = {
      rules: importable.filter((c) => c.kind === 'rule' && selected.has(c.sourcePath)).map((c) => c.sourcePath),
      workflows: importable
        .filter((c) => c.kind === 'workflow' && selected.has(c.sourcePath))
        .map((c) => c.sourcePath),
      skills: importable.filter((c) => c.kind === 'skill' && selected.has(c.sourcePath)).map((c) => c.sourcePath)
    }
    void applySelection(selection)
      .then((summary) => {
        setImporting(false)
        setSummaryText(
          `Imported ${summary.rulesImported} rule(s), ${summary.workflowsImported} workflow(s), ${summary.skillsImported} skill(s).`
        )
      })
      // Without this the button stayed "Importing…" forever on any rejection,
      // with nothing shown to the user (final review Finding 5).
      .catch((e: unknown) => {
        setImporting(false)
        setError(e instanceof Error ? e.message : 'Import failed')
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
              {error ?? summaryText ?? 'Choose what to bring into BearCode.'}
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
            {/* Scroll the LIST, not the panel (final review Finding 7): the
                panel itself is overflow:hidden with a capped max-height, so
                rows rendered as its direct children pushed the Import button
                out of the clipped area past ~9-10 candidates (easily reached
                by a real .cursor/rules/ directory) and made it unreachable.
                Same wrapper BrowseSmitheryModal uses for the same reason. */}
            <div className="smithery-results">
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
                    {c.preview ? <div className="import-preview">{c.preview}</div> : null}
                    {c.warnings?.length ? (
                      <div className="import-warning">
                        {c.warnings.length === 1
                          ? c.warnings[0]
                          : `${c.warnings.length} translation warnings: ${c.warnings.join('; ')}`}
                      </div>
                    ) : null}
                  </div>
                </label>
              ))}
              {skipped.map((c) => (
                <div className="set-row import-skipped" key={c.sourcePath}>
                  <div className="set-row-text">
                    <div className="set-row-title">{c.sourcePath}</div>
                    <div className="set-row-desc">
                      {c.notPreviewed
                        ? 'Too many sources detected — not previewed yet'
                        : "Couldn't parse — skipped"}
                    </div>
                  </div>
                </div>
              ))}
              {unsupported.map((c) => (
                <div className="set-row import-skipped" key={c.sourcePath}>
                  <div className="set-row-text">
                    <div className="set-row-title">{c.sourcePath}</div>
                    <div className="set-row-desc">{KIND_LABEL[c.kind]}</div>
                  </div>
                </div>
              ))}
            </div>
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
