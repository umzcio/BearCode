import { useEffect, useRef, useState } from 'react'
import type { CommandEntry, CommandRef } from '@shared/types'
import { ExecutionModePicker } from '../ExecutionModePicker/ExecutionModePicker'
import { ModelPicker } from '../ModelPicker/ModelPicker'
import { ModePicker } from '../ModePicker/ModePicker'
import { refConfigured, useAppStore } from '../../state/store'
import {
  IconArrowUp,
  IconChevronDown,
  IconClose,
  IconMic,
  IconMonitor,
  IconPlus,
  IconStop
} from '../icons'
import { SlashMenu } from './SlashMenu'
import { ResumePicker } from './ResumePicker'
import { filterSlashCommands } from './slashFilter'
import './Composer.css'

interface ComposerProps {
  onSend(text: string, command: CommandRef | null): void
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
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const openSettings = useAppStore((s) => s.openSettings)
  const commands = useAppStore((s) => s.commands)
  const refreshCommands = useAppStore((s) => s.refreshCommands)
  const resumePickerOpen = useAppStore((s) => s.resumePickerOpen)
  const setResumePickerOpen = useAppStore((s) => s.setResumePickerOpen)
  const [value, setValue] = useState('')
  const [command, setCommand] = useState<CommandRef | null>(null)
  // Escape closes the menu without clearing the typed "/query" text (design
  // 6.1); typing again reopens it -- tracked separately from `value` so
  // Escape's effect does not depend on rewriting the textarea's contents.
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [envOpen, setEnvOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const envRef = useRef<HTMLDivElement>(null)

  const modelReady = refConfigured(providers, modelRef)
  const showNotice = providers.length > 0 && !modelReady
  // The pill makes trailing text optional (design 5.2): a bare workflow/goal
  // send is valid, only an empty composer with no pill is not.
  const hasContent = value.trim() !== '' || command !== null

  // The menu opens only when the composer is otherwise empty and the very
  // first character typed is '/', and stays open while the text still starts
  // with '/' (design 6.1). A command pill already present suppresses it
  // entirely -- there is only ever one command per turn. An open resume
  // picker also suppresses it: the two popovers share the spot above the
  // composer and both react to arrows/enter/escape, so they must never
  // render stacked.
  const menuOpen =
    command === null && !menuDismissed && !resumePickerOpen && value.length > 0 && value[0] === '/'
  const filtered = menuOpen ? filterSlashCommands(value.slice(1), commands) : []
  const safeIndex = Math.min(highlightedIndex, Math.max(0, filtered.length - 1))

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

  // Re-fetched on menu open only (menu-open paced, matching the loader's own
  // cache design), not on every keystroke while it stays open.
  useEffect(() => {
    if (menuOpen) refreshCommands()
  }, [menuOpen, refreshCommands])

  const selectEntry = (entry: CommandEntry): void => {
    if (entry.status !== 'live') return
    if (entry.name === 'resume') {
      setResumePickerOpen(true)
      setValue('')
      setMenuDismissed(false)
      return
    }
    setCommand({ name: entry.name, kind: entry.kind })
    setValue('')
    setMenuDismissed(false)
  }

  const submit = (): void => {
    if (!hasContent || running || !modelReady) return
    const text = value.trim()
    const sentCommand = command
    setValue('')
    setCommand(null)
    onSend(text, sentCommand)
  }

  return (
    <div className="composer">
      {showNotice ? (
        <div className="composer-notice">
          No API key for the selected model.{' '}
          <span className="notice-link" onClick={openSettings}>
            Open Settings
          </span>
        </div>
      ) : null}
      {command ? (
        <div className="command-pill-row">
          <span className="command-pill">
            /{command.name}
            <button
              type="button"
              className="pill-x"
              title="Remove command"
              onClick={() => setCommand(null)}
            >
              <IconClose size={11} />
            </button>
          </span>
        </div>
      ) : null}
      <textarea
        ref={taRef}
        rows={1}
        placeholder="Ask anything, @ to mention, / for actions"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          setValue(e.target.value)
          setMenuDismissed(false)
        }}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHighlightedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHighlightedIndex((i) => Math.max(i - 1, 0))
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const entry = filtered[safeIndex]
              if (entry) selectEntry(entry)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setMenuDismissed(true)
              return
            }
          }
          if (
            e.key === 'Backspace' &&
            command !== null &&
            value === '' &&
            e.currentTarget.selectionStart === 0 &&
            e.currentTarget.selectionEnd === 0
          ) {
            e.preventDefault()
            setCommand(null)
            return
          }
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
        <ExecutionModePicker />
        <ModePicker />
        <button className="icon-btn mic-btn" disabled title="Voice input: coming soon">
          <IconMic />
        </button>
        {running ? (
          <button className="icon-btn send-btn stop" title="Stop" onClick={onStop}>
            <IconStop />
          </button>
        ) : hasContent && modelReady ? (
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
      {menuOpen ? (
        <div className="slash-menu-wrap">
          <SlashMenu
            entries={filtered}
            highlightedIndex={safeIndex}
            onHighlight={setHighlightedIndex}
            onSelect={selectEntry}
          />
        </div>
      ) : null}
      {resumePickerOpen ? (
        <div className="slash-menu-wrap">
          <ResumePicker />
        </div>
      ) : null}
    </div>
  )
}
