import { useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import { useModalDialog } from '../../lib/useModalDialog'
import { Select, type SelectOption } from '../Select'
import { IconClose } from '../icons'
import './AddCustomModelModal.css'

// The six first-party providers a custom model can be added under (Ollama is
// dynamic/local and manages its own catalog) -- moved verbatim from the old
// Settings/pages/ModelsPage.tsx "Add a model" section.
const ADDABLE_PROVIDERS: SelectOption<ProviderId>[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'xai', label: 'xAI' }
]

export function AddCustomModelModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const addCustomModel = useAppStore((s) => s.addCustomModel)
  const { mounted, state } = useAnimatedUnmount(true)
  const { ref: dialogRef, dialogProps } = useModalDialog(onClose)

  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [ctx, setCtx] = useState('')

  const ctxNum = Number(ctx)
  const valid = id.trim().length > 0 && label.trim().length > 0 && Number.isFinite(ctxNum) && ctxNum > 0
  const collides = manageableModels
    .find((p) => p.id === provider)
    ?.models.some((m) => !m.custom && m.id === id.trim())

  const submit = (): void => {
    if (!valid) return
    void addCustomModel({
      provider,
      id: id.trim(),
      label: label.trim(),
      contextWindow: Math.round(ctxNum)
    })
    onClose()
  }

  if (!mounted) return <></>

  return (
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="add-model-panel"
        data-state={state}
        ref={dialogRef}
        {...dialogProps}
        aria-label="Add a custom model"
      >
        <div className="amp-head">
          <h3>Add a custom model</h3>
          <button type="button" className="amp-close" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="amp-body">
          <div className="amp-field">
            <label>Provider</label>
            <Select ariaLabel="Add model provider" value={provider} onChange={setProvider} options={ADDABLE_PROVIDERS} />
          </div>
          <div className="amp-field">
            <label>Model ID</label>
            <input
              className="set-input"
              placeholder="Model ID (e.g. gemini-3.1-pro-preview)"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="amp-field">
            <label>Display name</label>
            <input
              className="set-input"
              placeholder="Display name (e.g. Gemini 3.1 Pro)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="amp-field">
            <label>Context window (tokens)</label>
            <input
              className="set-input"
              type="number"
              min="1"
              placeholder="Context window in tokens (e.g. 1000000)"
              value={ctx}
              onChange={(e) => setCtx(e.target.value)}
            />
          </div>
          {collides ? (
            <div className="amp-hint">
              A built-in model with this ID exists for {provider}; your custom entry will override it.
            </div>
          ) : null}
        </div>
        <div className="amp-footer">
          <button type="button" className="pill-btn" onClick={submit} disabled={!valid}>
            Add model
          </button>
        </div>
      </div>
    </div>
  )
}
