import { Fragment, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { OllamaInstance, ProviderId } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { ProviderIcon } from '../../ProviderIcon'
import { FieldHint } from '../../ui/FieldHint'

const KEY_PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' },
  { id: 'perplexity', label: 'Perplexity', placeholder: 'pplx-…' },
  { id: 'xai', label: 'xAI', placeholder: 'xai-…' }
]

// Mirrors isHttpUrl in src/main/settings.ts so the form can explain invalid
// input before it ever crosses IPC (main re-validates on write regardless).
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// The one validation message for a name+URL draft; the Add/Save button is
// disabled while this is non-null and a FieldHint shows the reason.
function endpointDraftError(name: string, url: string, urlExample: string): string | null {
  const nameBad = name.trim().length === 0
  const urlBad = !isHttpUrl(url.trim())
  if (nameBad && urlBad) return `Enter a name and a valid http(s) URL, e.g. ${urlExample}.`
  if (nameBad) return 'Enter a name for this server.'
  if (urlBad) return `Enter a valid http(s) URL, e.g. ${urlExample}.`
  return null
}

// Kebab slug derived from the display name ('GPU Box' -> 'gpu-box'), made
// unique against existing ids by appending -2, -3, ... Ids are stable: editing
// a server's name or URL never changes it.
function uniqueInstanceId(name: string, existing: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  let id = base
  for (let n = 2; existing.includes(id); n += 1) id = `${base}-${n}`
  return id
}

interface EndpointListCardProps {
  title: string
  subtitle?: string
  icon: ProviderId
  endpoints: OllamaInstance[]
  onSave: (endpoints: OllamaInstance[]) => void
  namePlaceholder: string
  urlPlaceholder: string
  // Example URL used in validation messages.
  urlExample: string
  hint: string
  // Accessible labels differ per card so both managers can live on one page
  // (and so tests can query either unambiguously).
  labels: { newName: string; newUrl: string; editName: string; editUrl: string }
  // Accessible name for the Add button; omitted it stays the visible 'Add'.
  addAriaLabel?: string
  // Wrapper class scoping the row CSS ('ollama-instances' / 'endpoint-list').
  cardClassName: string
  // Aggregate reachability dot shown on the primary row only (Ollama).
  primaryDot?: { ok: boolean; title: string }
  // Per-endpoint write-only API keys in the main-process vault, namespaced
  // `compat:<endpointId>` (OpenAI-compatible servers only). The renderer only
  // ever sees booleans via compatKeyStatus -- plaintext keys never cross back.
  keySupport?: boolean
}

// Shared name/URL endpoint manager: rows with edit/remove, an add row with
// FieldHint validation, first-is-primary semantics. Rendered twice on this
// page -- Ollama instances and OpenAI-compatible servers; the compat card
// adds a per-endpoint write-only API key field via `keySupport`.
function EndpointListCard({
  title,
  subtitle,
  icon,
  endpoints,
  onSave,
  namePlaceholder,
  urlPlaceholder,
  urlExample,
  hint,
  labels,
  addAriaLabel,
  cardClassName,
  primaryDot,
  keySupport = false
}: EndpointListCardProps): JSX.Element {
  const [addDraft, setAddDraft] = useState({ name: '', url: '' })
  const [addKeyDraft, setAddKeyDraft] = useState('')
  const [editDraft, setEditDraft] = useState<{ id: string; name: string; url: string } | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})

  // Booleans only, keyed by endpoint id. Fetched on mount and after every
  // save so the 'Configured' indicators track the vault.
  const refreshKeyStatus = (): void => {
    if (!keySupport) return
    void window.bearcode.compatKeyStatus().then(setKeyStatus)
  }
  useEffect(() => {
    if (!keySupport) return
    void window.bearcode.compatKeyStatus().then(setKeyStatus)
  }, [keySupport])

  const addTouched = addDraft.name !== '' || addDraft.url !== ''
  const addError = endpointDraftError(addDraft.name, addDraft.url, urlExample)
  const editOriginal = editDraft ? endpoints.find((i) => i.id === editDraft.id) : undefined
  const editError = editDraft ? endpointDraftError(editDraft.name, editDraft.url, urlExample) : null
  const editDirty =
    !!editDraft &&
    !!editOriginal &&
    (editDraft.name.trim() !== editOriginal.name || editDraft.url.trim() !== editOriginal.baseUrl)

  const addEndpoint = (): void => {
    if (!addTouched || addError !== null) return
    const name = addDraft.name.trim()
    const id = uniqueInstanceId(
      name,
      endpoints.map((i) => i.id)
    )
    onSave([...endpoints, { id, name, baseUrl: addDraft.url.trim() }])
    if (keySupport) {
      const key = addKeyDraft.trim()
      if (key) void window.bearcode.compatSetKey(id, key).then(refreshKeyStatus)
      else refreshKeyStatus()
    }
    setAddDraft({ name: '', url: '' })
    setAddKeyDraft('')
  }

  const saveEdit = (): void => {
    if (!editDraft || editError !== null || !editDirty) return
    const { id, name, url } = editDraft
    onSave(
      endpoints.map((i) => (i.id === id ? { ...i, name: name.trim(), baseUrl: url.trim() } : i))
    )
    setEditDraft(null)
  }

  // Removing the primary promotes the next entry (order is significant: the
  // first entry IS the primary). A removed endpoint's vault key is cleared
  // too; an emptied list is main's cue to reset/clear defaults.
  const removeEndpoint = (id: string): void => {
    if (editDraft?.id === id) setEditDraft(null)
    onSave(endpoints.filter((i) => i.id !== id))
    if (keySupport) void window.bearcode.compatSetKey(id, '').then(refreshKeyStatus)
  }

  // Mirrors the API Keys card: the field is write-only, an empty save clears
  // the stored key, and the placeholder/dot report presence (never the key).
  const saveEndpointKey = (id: string): void => {
    const value = (keyDrafts[id] ?? '').trim()
    void window.bearcode.compatSetKey(id, value).then(refreshKeyStatus)
    setKeyDrafts((d) => ({ ...d, [id]: '' }))
  }

  return (
    <>
      <div className="set-group-title">{title}</div>
      {subtitle && (
        <div className="page-sub" style={{ margin: '-6px 2px 10px' }}>
          {subtitle}
        </div>
      )}
      <div className={`set-card pad ${cardClassName}`}>
        {endpoints.map((inst, index) => (
          <Fragment key={inst.id}>
            {editDraft?.id === inst.id ? (
              <div className="key-row">
                <span className="ollama-dot-spacer" />
                <input
                  aria-label={labels.editName}
                  placeholder="Name"
                  maxLength={40}
                  value={editDraft.name}
                  onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                />
                <input
                  aria-label={labels.editUrl}
                  className="ollama-url-input"
                  placeholder={urlPlaceholder}
                  value={editDraft.url}
                  onChange={(e) => setEditDraft({ ...editDraft, url: e.target.value })}
                />
                <button
                  className="small-btn"
                  disabled={!editDirty || editError !== null}
                  onClick={saveEdit}
                >
                  Save
                </button>
                <button className="small-btn" onClick={() => setEditDraft(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="key-row">
                {keySupport ? (
                  <span
                    className={'status-dot' + (keyStatus[inst.id] ? ' ok' : '')}
                    title={keyStatus[inst.id] ? 'API key configured' : 'No API key configured'}
                  />
                ) : index === 0 && primaryDot ? (
                  <span
                    className={'status-dot' + (primaryDot.ok ? ' ok' : '')}
                    title={primaryDot.title}
                  />
                ) : (
                  <span className="ollama-dot-spacer" />
                )}
                <span className="ollama-name-label">
                  <ProviderIcon provider={icon} size={14} />
                  <span className="ollama-name">{inst.name}</span>
                </span>
                {index === 0 && endpoints.length > 1 && (
                  <span className="ollama-primary-tag">Primary</span>
                )}
                <span className="ollama-url">{inst.baseUrl}</span>
                {keySupport && (
                  <>
                    <input
                      type="password"
                      aria-label={`API key for ${inst.name}`}
                      className="endpoint-key-input"
                      placeholder={keyStatus[inst.id] ? 'Configured' : 'API key (optional)'}
                      value={keyDrafts[inst.id] ?? ''}
                      onChange={(e) => setKeyDrafts((d) => ({ ...d, [inst.id]: e.target.value }))}
                    />
                    <button
                      className="small-btn"
                      disabled={!(keyDrafts[inst.id] ?? '').trim() && !keyStatus[inst.id]}
                      onClick={() => saveEndpointKey(inst.id)}
                    >
                      {(keyDrafts[inst.id] ?? '').trim()
                        ? 'Save'
                        : keyStatus[inst.id]
                          ? 'Remove'
                          : 'Save'}
                    </button>
                  </>
                )}
                <button
                  className="small-btn"
                  aria-label={`Edit ${inst.name}`}
                  onClick={() => setEditDraft({ id: inst.id, name: inst.name, url: inst.baseUrl })}
                >
                  Edit
                </button>
                <button
                  className="small-btn"
                  aria-label={`Remove ${inst.name}`}
                  onClick={() => removeEndpoint(inst.id)}
                >
                  Remove
                </button>
              </div>
            )}
            {editDraft?.id === inst.id && (
              <FieldHint show={editError !== null}>{editError}</FieldHint>
            )}
          </Fragment>
        ))}
        <div className="key-row">
          <span className="ollama-dot-spacer" />
          <input
            aria-label={labels.newName}
            placeholder={namePlaceholder}
            maxLength={40}
            value={addDraft.name}
            onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })}
          />
          <input
            aria-label={labels.newUrl}
            className="ollama-url-input"
            placeholder={urlPlaceholder}
            value={addDraft.url}
            onChange={(e) => setAddDraft({ ...addDraft, url: e.target.value })}
          />
          {keySupport && (
            <input
              type="password"
              aria-label="New endpoint API key"
              className="endpoint-key-input"
              placeholder="API key (optional)"
              value={addKeyDraft}
              onChange={(e) => setAddKeyDraft(e.target.value)}
            />
          )}
          <button
            className="small-btn"
            aria-label={addAriaLabel}
            disabled={!addTouched || addError !== null}
            onClick={addEndpoint}
          >
            Add
          </button>
        </div>
        <FieldHint show={addTouched && addError !== null}>{addError}</FieldHint>
        <div className="page-sub" style={{ marginTop: 6 }}>
          {hint}
        </div>
      </div>
    </>
  )
}

export function ProvidersPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveKey = useAppStore((s) => s.saveKey)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [smitheryKey, setSmitheryKey] = useState('')
  const [smitherySaved, setSmitherySaved] = useState(false)

  if (!settings) return null

  // The Smithery registry API key lives in the vault (write-only over IPC --
  // there is no getter, so the key never crosses back to the renderer). Browse
  // Smithery (Connectors) reads it in main via getVaultSecret('smithery:apiKey')
  // and shows an empty-state pointing here when it is absent, so this field is
  // the one place that writes it.
  const saveSmitheryKey = (): void => {
    const value = smitheryKey.trim()
    if (!value) return
    void window.bearcode.mcp.setSecret('smithery:apiKey', value).then(() => {
      setSmitheryKey('')
      setSmitherySaved(true)
    })
  }

  const configured = (id: ProviderId): boolean =>
    providers.find((p) => p.id === id)?.keyConfigured ?? false

  const instances: OllamaInstance[] =
    settings.ollamaInstances && settings.ollamaInstances.length > 0
      ? settings.ollamaInstances
      : [{ id: 'local', name: 'Local', baseUrl: settings.ollamaBaseUrl }]

  // Per-instance reachability is not in the providers payload yet: the ollama
  // provider row reports reachable when ANY instance answers, so the dot is
  // shown only on the primary row as an aggregate, never per row.
  const ollamaReachable = providers.find((p) => p.id === 'ollama')?.reachable ?? false
  const ollamaPrimaryDotTitle =
    instances.length > 1
      ? ollamaReachable
        ? 'At least one configured server is reachable'
        : 'No configured server is reachable'
      : ollamaReachable
        ? 'Connected'
        : 'Not reachable'

  // OpenAI-compatible endpoints are never seeded: absent stays empty and the
  // card shows just the add row.
  const compatEndpoints: OllamaInstance[] = settings.compatEndpoints ?? []

  return (
    <>
      <div className="page-title">Providers</div>
      <div className="page-sub">
        API keys and local model endpoints. Connection status is shown per provider.
      </div>

      <div className="set-group-title">API Keys</div>
      <div className="set-card pad">
        {KEY_PROVIDERS.map((p) => (
          <div className="key-row" key={p.id}>
            <span className={'status-dot' + (configured(p.id) ? ' ok' : '')} />
            <span className="key-label icon-label">
              <ProviderIcon provider={p.id} size={14} />
              {p.label}
            </span>
            <input
              type="password"
              placeholder={configured(p.id) ? 'Configured' : p.placeholder}
              value={keyDrafts[p.id] ?? ''}
              onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
            />
            <button
              className="small-btn"
              disabled={!(keyDrafts[p.id] ?? '').trim() && !configured(p.id)}
              onClick={() => {
                void saveKey(p.id, (keyDrafts[p.id] ?? '').trim())
                setKeyDrafts((d) => ({ ...d, [p.id]: '' }))
              }}
            >
              {(keyDrafts[p.id] ?? '').trim() ? 'Save' : configured(p.id) ? 'Remove' : 'Save'}
            </button>
          </div>
        ))}
      </div>

      <EndpointListCard
        title="Ollama"
        icon="ollama"
        endpoints={instances}
        onSave={(next) => void saveSettings({ ollamaInstances: next })}
        namePlaceholder="Name (e.g. GPU box)"
        urlPlaceholder="http://localhost:11434"
        urlExample="http://localhost:11434"
        hint="The first server is the primary — its models keep their unprefixed ollama/model refs; models on other servers are namespaced by server. Removing the primary promotes the next one."
        labels={{
          newName: 'New server name',
          newUrl: 'New server URL',
          editName: 'Edit server name',
          editUrl: 'Edit server URL'
        }}
        cardClassName="ollama-instances"
        primaryDot={{ ok: ollamaReachable, title: ollamaPrimaryDotTitle }}
      />

      <EndpointListCard
        title="OpenAI-Compatible Servers"
        subtitle="Any server that speaks the OpenAI chat API — vLLM, LM Studio, llama.cpp, TabbyAPI."
        icon="compat"
        endpoints={compatEndpoints}
        onSave={(next) => void saveSettings({ compatEndpoints: next })}
        namePlaceholder="Name (e.g. vLLM)"
        urlPlaceholder="http://localhost:8000/v1"
        urlExample="http://localhost:8000/v1"
        hint="The first server is the primary — its models keep their unprefixed compat/model refs; models on other servers are namespaced by server. Removing the primary promotes the next one. API keys are optional and write-only; removing a server also clears its stored key."
        labels={{
          newName: 'New endpoint name',
          newUrl: 'New endpoint URL',
          editName: 'Edit endpoint name',
          editUrl: 'Edit endpoint URL'
        }}
        addAriaLabel="Add endpoint"
        cardClassName="endpoint-list"
        keySupport
      />

      <div className="set-group-title">Smithery</div>
      <div className="set-card pad">
        <div className="key-row">
          <span className={'status-dot' + (smitherySaved ? ' ok' : '')} />
          <span className="key-label" title="Smithery registry API key">
            Smithery API key
          </span>
          <input
            type="password"
            placeholder={smitherySaved ? 'Saved' : 'smithery-…'}
            value={smitheryKey}
            onChange={(e) => {
              setSmitheryKey(e.target.value)
              setSmitherySaved(false)
            }}
          />
          <button className="small-btn" disabled={!smitheryKey.trim()} onClick={saveSmitheryKey}>
            Save
          </button>
        </div>
        <div className="page-sub" style={{ marginTop: 6 }}>
          Used to browse and install servers from the Smithery registry under Connectors.
        </div>
      </div>
    </>
  )
}
