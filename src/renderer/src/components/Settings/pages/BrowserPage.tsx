import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { IconClose } from '../../icons'
import { EmptyState } from '../../ui/EmptyState'
import { Loading } from '../../ui/Loading'

// A settings row: title + description on the left, the control on the right.
function Row({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        <div className="set-row-desc">{desc}</div>
      </div>
      {children ?? null}
    </div>
  )
}

// A custom add/remove domain-list editor (never a native multiselect): a text
// input + Add button on top, removable chips below. Empty/duplicate entries are
// ignored so the persisted list stays clean.
function DomainListEditor({
  list,
  placeholder,
  addLabel,
  onChange
}: {
  list: string[]
  placeholder: string
  addLabel: string
  onChange: (next: string[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const v = draft.trim()
    if (!v || list.includes(v)) return
    onChange([...list, v])
    setDraft('')
  }
  const remove = (v: string): void => {
    onChange(list.filter((x) => x !== v))
  }
  return (
    <div className="domain-editor">
      <div className="domain-add">
        <input
          type="text"
          className="set-input"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button className="pill-btn" aria-label={addLabel} onClick={add}>
          Add
        </button>
      </div>
      {list.length > 0 ? (
        <div className="domain-chips">
          {list.map((d) => (
            <span className="domain-chip" key={d}>
              <span className="domain-chip-text">{d}</span>
              <button
                className="domain-chip-x"
                aria-label={`Remove ${d}`}
                title={`Remove ${d}`}
                onClick={() => remove(d)}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <EmptyState title="None yet" />
      )}
    </div>
  )
}

type BrowserStatus = {
  installed: boolean
  connected: boolean
  conversationId: string | null
  debuggingEnabled: boolean
}

export function BrowserPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    let alive = true
    void window.bearcode.browser.status().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings) return null

  const enabled = settings.browserEnabled === true
  const allowlist = settings.browserAllowlist ?? []
  const blocklist = settings.browserBlocklist ?? []

  // The CDP remote-debugging endpoint is opened ONCE at boot from the persisted
  // setting (see src/main/index.ts / mainWindow.ts). Toggling Enable here writes
  // the setting immediately, but the endpoint state only changes on relaunch —
  // so the toggle can diverge from what's actually live. Surface a relaunch note
  // whenever they differ, in BOTH directions:
  //  · enabled now, endpoint still closed → tools refuse until relaunch.
  //  · disabled now, endpoint still open  → port stays reachable until relaunch.
  const needsRelaunch = status !== null && enabled !== status.debuggingEnabled
  const relaunchMsg = enabled
    ? 'Relaunch BearCode to finish enabling the browser — it stays inactive until you do.'
    : 'Relaunch BearCode to finish turning the browser off — its debugging port stays open until you do.'

  const clearSession = (): void => {
    void window.bearcode.browser.clearSession().then(() => {
      setCleared(true)
      window.setTimeout(() => setCleared(false), 2000)
    })
  }

  return (
    <>
      <div className="page-title">Browser</div>
      <div className="page-sub">
        Give the agent controlled access to a real, embedded web browser. Off by default.
      </div>

      <div className="set-group-title">Access</div>
      <div className="set-card">
        <Row
          title="Enable Browser"
          desc="Let the agent drive an embedded browser via the /browser command and browser_* tools. When off, the browser never launches and every browser action is refused. Changes take effect after you relaunch BearCode."
        >
          <Toggle
            ariaLabel="Enable browser"
            checked={enabled}
            onChange={(on) => void saveSettings({ browserEnabled: on })}
          />
        </Row>
        {needsRelaunch ? (
          <div className="browser-relaunch-note" role="status">
            {relaunchMsg}
          </div>
        ) : null}
      </div>

      <div className="set-group-title">Domain Policy</div>
      <div className="set-card">
        <Row
          title="Allowed Domains"
          desc="If any are listed, the browser may only visit these origins; anything else prompts for approval. Leave empty to allow all origins except those blocked below."
        >
          <span />
        </Row>
        <div className="set-row set-row-editor">
          <DomainListEditor
            list={allowlist}
            placeholder="Add an allowed origin, e.g. https://example.com"
            addLabel="Add allowed domain"
            onChange={(next) => void saveSettings({ browserAllowlist: next })}
          />
        </div>
        <Row
          title="Blocked Domains"
          desc="Origins the browser may never visit. Blocklist always wins over the allowlist."
        >
          <span />
        </Row>
        <div className="set-row set-row-editor">
          <DomainListEditor
            list={blocklist}
            placeholder="Add a blocked origin, e.g. https://evil.com"
            addLabel="Add blocked domain"
            onChange={(next) => void saveSettings({ browserBlocklist: next })}
          />
        </div>
      </div>

      <div className="set-group-title">Session &amp; Engine</div>
      <div className="set-card">
        <Row
          title="Browser Session"
          desc="Cookies, storage, and cache from the agent's browsing. Clearing signs out of every site the agent visited."
        >
          <button className="pill-btn" onClick={clearSession}>
            {cleared ? 'Cleared' : 'Clear Session'}
          </button>
        </Row>
        <Row
          title="Status"
          desc="The browser engine (Chromium) downloads on first use (~150 MB). Connection reflects whether a browser session is currently live."
        >
          {status === null ? (
            <Loading label="Checking…" />
          ) : (
            <span className="browser-status">
              <span className={'status-dot' + (status.installed ? ' ok' : '')} />
              {status.installed ? 'Engine installed' : 'Engine not installed'}
              {' · '}
              {status.connected ? 'Connected' : 'Idle'}
            </span>
          )}
        </Row>
      </div>
    </>
  )
}
