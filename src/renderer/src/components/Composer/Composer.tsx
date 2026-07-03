import { useEffect, useRef, useState } from 'react'
import { ModelPicker } from '../ModelPicker/ModelPicker'
import { IconArrowUp, IconChevronDown, IconMic, IconMonitor, IconPlus, IconStop } from '../icons'
import './Composer.css'

interface ComposerProps {
  onSend(text: string): void
  running?: boolean
  onStop?(): void
  showEnvRow?: boolean
  autoFocus?: boolean
}

export function Composer({
  onSend,
  running = false,
  onStop,
  showEnvRow = false,
  autoFocus = false
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [envOpen, setEnvOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const envRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '52px'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [value])

  useEffect(() => {
    if (!envOpen) return undefined
    const close = (e: MouseEvent): void => {
      if (envRef.current && !envRef.current.contains(e.target as Node)) setEnvOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [envOpen])

  const submit = (): void => {
    const text = value.trim()
    if (!text || running) return
    setValue('')
    onSend(text)
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        rows={1}
        placeholder="Ask anything, @ to mention, / for actions"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-controls">
        <button className="icon-btn" disabled title="Attach: coming soon">
          <IconPlus />
        </button>
        <ModelPicker />
        <button className="icon-btn mic-btn" disabled title="Voice input: coming soon">
          <IconMic />
        </button>
        {running ? (
          <button className="icon-btn send-btn stop" title="Stop" onClick={onStop}>
            <IconStop />
          </button>
        ) : value.trim() ? (
          <button className="icon-btn send-btn" title="Send" onClick={submit}>
            <IconArrowUp />
          </button>
        ) : null}
      </div>
      {showEnvRow ? (
        <div className="env-row">
          <div className="env-picker" ref={envRef}>
            <button className="pill-btn" onClick={() => setEnvOpen((o) => !o)}>
              <IconMonitor />
              <span>Local</span>
              <span className="chev">
                <IconChevronDown />
              </span>
            </button>
            {envOpen ? (
              <div className="menu env-menu">
                <div className="menu-item selected">
                  <span>Local</span>
                  <span className="check">✓</span>
                </div>
                <div className="menu-item disabled" title="Coming soon">
                  <span>Remote sandbox</span>
                  <span className="badge">coming soon</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
