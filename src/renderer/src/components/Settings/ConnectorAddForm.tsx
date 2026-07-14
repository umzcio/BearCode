import type { JSX } from 'react'
import type { McpTransport } from '@shared/types'
import { Select } from '../Select'
import type { SelectOption } from '../Select'
import { FieldHint } from '../ui/FieldHint'

export type ManualDraft = {
  name: string
  transport: McpTransport
  scope: 'global' | 'project'
  url: string
  command: string
  args: string
  headers: string
  env: string
}

export const EMPTY_MANUAL_DRAFT: ManualDraft = {
  name: '',
  transport: 'http',
  scope: 'global',
  url: '',
  command: '',
  args: '',
  headers: '',
  env: ''
}

// Parses "k=v, k2=v2" into a Record, ignoring blank/malformed entries.
export function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const [k, ...rest] = part.split('=')
    const key = k?.trim()
    const val = rest.join('=').trim()
    if (key && val) out[key] = val
  }
  return out
}

export function isManualDraftValid(draft: ManualDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    (draft.transport === 'http' ? draft.url.trim().length > 0 : draft.command.trim().length > 0)
  )
}

const SCOPE_OPTIONS: SelectOption<'global' | 'project'>[] = [
  {
    value: 'global',
    label: 'Global (this machine)',
    description: 'Private to you; never committed'
  },
  {
    value: 'project',
    label: 'Project (committed)',
    description: 'Written to .agents/mcp.json and shared with the repo'
  }
]

// The manual-add-a-server form: shared by ConnectorsPage (global Settings,
// scope is a user choice when a workspace is open) and ProjectConnectorsTab
// (per-project modal, scope is always 'project' and the selector is hidden).
export function ConnectorAddForm({
  draft,
  onChange,
  onSubmit,
  showScopeSelector
}: {
  draft: ManualDraft
  onChange: (next: ManualDraft) => void
  onSubmit: () => void
  showScopeSelector: boolean
}): JSX.Element {
  const valid = isManualDraftValid(draft)
  return (
    <div className="connector-add-form">
      <input
        type="text"
        className="set-input"
        placeholder="Server name"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
      />
      <Select
        ariaLabel="Transport"
        value={draft.transport}
        options={[
          { value: 'http', label: 'Remote (HTTP)' },
          { value: 'stdio', label: 'Local (stdio)' }
        ]}
        onChange={(transport) => onChange({ ...draft, transport })}
      />
      {showScopeSelector ? (
        <Select
          ariaLabel="Scope"
          value={draft.scope}
          options={SCOPE_OPTIONS}
          onChange={(scope) => onChange({ ...draft, scope })}
        />
      ) : null}
      {draft.transport === 'http' ? (
        <>
          <input
            type="text"
            className="set-input"
            placeholder="https://server.example/mcp"
            value={draft.url}
            onChange={(e) => onChange({ ...draft, url: e.target.value })}
          />
          <input
            type="text"
            className="set-input"
            placeholder="Headers: key=value, key2=value2"
            value={draft.headers}
            onChange={(e) => onChange({ ...draft, headers: e.target.value })}
          />
        </>
      ) : (
        <>
          <input
            type="text"
            className="set-input"
            placeholder="Command, e.g. npx"
            value={draft.command}
            onChange={(e) => onChange({ ...draft, command: e.target.value })}
          />
          <input
            type="text"
            className="set-input"
            placeholder="Args, comma-separated"
            value={draft.args}
            onChange={(e) => onChange({ ...draft, args: e.target.value })}
          />
          <input
            type="text"
            className="set-input"
            placeholder="Env: key=value, key2=value2"
            value={draft.env}
            onChange={(e) => onChange({ ...draft, env: e.target.value })}
          />
        </>
      )}
      <FieldHint show={!valid}>
        {draft.transport === 'http' ? 'Name and URL are required.' : 'Name and command are required.'}
      </FieldHint>
      <button className="pill-btn primary" disabled={!valid} onClick={onSubmit}>
        Add server
      </button>
    </div>
  )
}
