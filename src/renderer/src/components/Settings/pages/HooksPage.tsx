import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { HookAuthoringInput, HookEvent, HookRecord } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { Select } from '../../Select'
import type { SelectOption } from '../../Select'
import { PluginBadge } from '../../PluginBadge'

const KEBAB_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const EVENT_OPTIONS: SelectOption<HookEvent>[] = [
  { value: 'PreToolUse', label: 'Pre Tool Use' },
  { value: 'PostToolUse', label: 'Post Tool Use' }
]

type Draft = {
  originalName: string | null
  name: string
  event: HookEvent
  matcher: string
  command: string
  timeout: string
}

function emptyDraft(): Draft {
  return {
    originalName: null,
    name: '',
    event: 'PreToolUse',
    matcher: '',
    command: '',
    timeout: '30'
  }
}

// The source badge for a row: global hooks live in their own editable
// section (no badge needed); project/plugin hooks are foreign, read-only
// entries that need their provenance visible before a user consents.
function SourceBadge({ entry }: { entry: HookRecord }): JSX.Element | null {
  if (entry.plugin) return <PluginBadge name={entry.plugin} />
  if (entry.scope === 'project') return <span className="connector-badge local">Project</span>
  return null
}

export function HooksPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [hooks, setHooks] = useState<HookRecord[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const refresh = (): void => {
    void window.bearcode.hooks.list(workspacePath).then(setHooks)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  if (!settings) return null

  const startCreate = (): void => setDraft(emptyDraft())

  const startEdit = (entry: HookRecord): void => {
    setDraft({
      originalName: entry.name,
      name: entry.name,
      event: entry.event,
      matcher: entry.matcher,
      command: entry.command,
      timeout: String(entry.timeout)
    })
  }

  const submitDraft = (): void => {
    if (!draft) return
    const timeoutNum = Number(draft.timeout)
    const input: HookAuthoringInput = {
      name: draft.name.trim(),
      event: draft.event,
      matcher: draft.matcher.trim(),
      command: draft.command,
      timeout: Number.isFinite(timeoutNum) && timeoutNum > 0 ? timeoutNum : undefined
    }
    const action = draft.originalName
      ? window.bearcode.hooks.update(draft.originalName, input)
      : window.bearcode.hooks.create(input)
    void action.then(() => {
      setDraft(null)
      refresh()
    })
  }

  const deleteHook = (name: string): void => {
    void window.bearcode.hooks.delete(name).then(refresh)
  }

  // setActive's `source` is only meaningful for project/plugin scope (state.ts
  // keys the consent set on it); global hooks toggle by name alone, so any
  // placeholder string works there.
  const toggleActive = (entry: HookRecord, on: boolean): void => {
    const source =
      entry.scope === 'project'
        ? (workspacePath ?? '')
        : entry.scope === 'plugin'
          ? (entry.plugin ?? '')
          : 'global'
    void window.bearcode.hooks
      .setActive(entry.scope, source, entry.name, on, workspacePath)
      .then(refresh)
  }

  const draftValid =
    !!draft && KEBAB_PATTERN.test(draft.name.trim()) && draft.command.trim().length > 0

  const globalHooks = (hooks ?? []).filter((h) => h.scope === 'global')
  const projectHooks = (hooks ?? []).filter((h) => h.scope === 'project')
  const pluginHooks = (hooks ?? []).filter((h) => h.scope === 'plugin')

  const renderRow = (entry: HookRecord, editable: boolean): JSX.Element => (
    <div className="set-row hook-row" key={`${entry.scope}:${entry.plugin ?? ''}:${entry.name}`}>
      <div className="set-row-text">
        <div className="set-row-title">
          {entry.name}
          <span className="connector-badge">
            {entry.event} · {entry.matcher || '*'}
          </span>
          <SourceBadge entry={entry} />
        </div>
        <div className="set-row-desc">
          <code className="hook-command">{entry.command}</code>
        </div>
      </div>
      <Toggle
        ariaLabel={`Enable ${entry.name}`}
        checked={entry.consented}
        onChange={(on) => toggleActive(entry, on)}
      />
      {editable ? (
        <div className="hook-actions">
          <button className="pill-btn" onClick={() => startEdit(entry)}>
            Edit
          </button>
          <button className="pill-btn" onClick={() => deleteHook(entry.name)}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      <div className="page-title">Hooks</div>
      <div className="page-sub">
        Shell commands that fire automatically at the agent&apos;s tool-execution boundary. Hooks
        can only tighten a permission decision (deny or ask) — never bypass it — and a broken hook
        always fails open. Project and plugin hooks stay off until you explicitly turn them on.
      </div>

      <div className="set-group-title">Global hooks</div>
      <div className="set-card">
        {hooks === null ? (
          <div className="set-row">
            <div className="set-row-desc">Loading…</div>
          </div>
        ) : globalHooks.length === 0 ? (
          <div className="set-row">
            <div className="set-row-desc">No global hooks yet — add one below.</div>
          </div>
        ) : (
          globalHooks.map((h) => renderRow(h, true))
        )}
      </div>

      {draft ? (
        <div className="set-card hook-add-card">
          <div className="hook-form">
            <div className="hook-field">
              <div className="set-row-title">Name</div>
              <input
                className="set-input"
                aria-label="Hook name"
                placeholder="e.g. format-on-write"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="hook-field">
              <div className="set-row-title">Event</div>
              <Select
                value={draft.event}
                options={EVENT_OPTIONS}
                onChange={(event) => setDraft({ ...draft, event })}
                ariaLabel="Hook event"
              />
            </div>
            <div className="hook-field">
              <div className="set-row-title">Matcher</div>
              <input
                className="set-input"
                aria-label="Hook matcher"
                placeholder="Tool-name regex, blank = all tools"
                value={draft.matcher}
                onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
              />
            </div>
            <div className="hook-field">
              <div className="set-row-title">Command</div>
              <textarea
                className="set-textarea"
                aria-label="Hook command"
                rows={4}
                value={draft.command}
                placeholder='Reads the tool call as JSON on stdin, writes {"decision":...} on stdout'
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              />
            </div>
            <div className="hook-field">
              <div className="set-row-title">Timeout (seconds)</div>
              <input
                className="set-input"
                type="number"
                min={1}
                max={120}
                aria-label="Hook timeout in seconds"
                value={draft.timeout}
                onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
              />
            </div>
            <div className="hook-form-actions">
              <button className="pill-btn" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="pill-btn primary" disabled={!draftValid} onClick={submitDraft}>
                {draft.originalName ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="pill-btn hook-new-btn" onClick={startCreate}>
          + New global hook
        </button>
      )}

      {projectHooks.length > 0 ? (
        <>
          <div className="set-group-title">Project hooks</div>
          <div className="set-card">{projectHooks.map((h) => renderRow(h, false))}</div>
        </>
      ) : null}

      {pluginHooks.length > 0 ? (
        <>
          <div className="set-group-title">Plugin hooks</div>
          <div className="set-card">{pluginHooks.map((h) => renderRow(h, false))}</div>
        </>
      ) : null}
    </>
  )
}
