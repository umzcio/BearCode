import { useEffect, useRef, useState } from 'react'
import type {
  AttachmentRef,
  CommandEntry,
  CommandRef,
  MentionRef,
  PickedAttachmentWire
} from '@shared/types'
import { URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { ModelPicker } from '../ModelPicker/ModelPicker'
import { ModePicker } from '../ModePicker/ModePicker'
import { EffortPicker } from '../EffortPicker/EffortPicker'
import { UrsaModePicker } from '../UrsaModePicker/UrsaModePicker'
import { ContextMeter } from '../ContextMeter/ContextMeter'
import { Hint } from '../Hint'
import { Menu, type MenuGroup } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { useShallow } from 'zustand/react/shallow'
import { refConfigured, useAppStore } from '../../state/store'
import { attachmentBadge } from '../../lib/attachmentBadge'
import {
  IconArrowUp,
  IconAt,
  IconChevronDown,
  IconClose,
  IconGlobe,
  IconImage,
  IconMic,
  IconMonitor,
  IconGitBranch,
  IconPlus,
  IconSlash,
  IconStop
} from '../icons'
import { SlashMenu } from './SlashMenu'
import { MentionMenu } from './MentionMenu'
import { ResumePicker } from './ResumePicker'
import { useVoiceRecorder } from './useVoiceRecorder'
import { filterSlashCommands } from './slashFilter'
import {
  activeMentionQuery,
  buildMentionRows,
  mentionCategoryPrefix,
  parseMentionQuery,
  type MentionRow
} from './mentionQuery'
import './Composer.css'

interface ComposerProps {
  onSend(
    text: string,
    command: CommandRef | null,
    mentions: MentionRef[],
    attachments: AttachmentRef[]
  ): void
  running?: boolean
  onStop?(): void
  showEnvRow?: boolean
  autoFocus?: boolean
  conversationId?: string
}

export function Composer({
  onSend,
  running = false,
  onStop,
  showEnvRow = false,
  autoFocus = false,
  conversationId
}: ComposerProps): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const openSettings = useAppStore((s) => s.openSettings)
  const commands = useAppStore((s) => s.commands)
  const refreshCommands = useAppStore((s) => s.refreshCommands)
  const resumePickerOpen = useAppStore((s) => s.resumePickerOpen)
  const setResumePickerOpen = useAppStore((s) => s.setResumePickerOpen)
  const fileSuggestions = useAppStore((s) => s.fileSuggestions)
  const manualRules = useAppStore((s) => s.manualRules)
  const mcpConnectors = useAppStore((s) => s.mcpConnectors)
  const manualSkills = useAppStore((s) => s.manualSkills)
  const suggestFiles = useAppStore((s) => s.suggestFiles)
  const refreshManualRules = useAppStore((s) => s.refreshManualRules)
  const refreshMcpConnectors = useAppStore((s) => s.refreshMcpConnectors)
  const refreshManualSkills = useAppStore((s) => s.refreshManualSkills)
  const convoOrder = useAppStore((s) => s.convoOrder)
  // Scoped to the active conversation's fields the env-lock check reads --
  // avoids re-rendering on every streamed event of any other conversation.
  const activeConvo = useAppStore(
    useShallow((s) => {
      if (!conversationId) return undefined
      const c = s.conversations[conversationId]
      return c ? { eventsLen: c.events.length, environment: c.environment } : undefined
    })
  )
  // Scoped to id/title (primitives, so shallow-compare actually catches
  // no-op re-renders) for the @-mention "Conversations" category list --
  // never re-renders on unrelated conversations' streamed events.
  const mentionConvoEntries = useAppStore(
    useShallow((s) =>
      convoOrder
        .map((id) => s.conversations[id])
        .filter((c): c is NonNullable<typeof c> => c != null)
        .flatMap((c) => [c.id, c.title])
    )
  )
  const pickAttachments = useAppStore((s) => s.pickAttachments)
  const showToast = useAppStore((s) => s.showToast)
  const composerEnvironment = useAppStore((s) => s.composerEnvironment)
  const setComposerEnvironment = useAppStore((s) => s.setComposerEnvironment)
  const [value, setValue] = useState('')
  const [command, setCommand] = useState<CommandRef | null>(null)
  const [mentions, setMentions] = useState<MentionRef[]>([])
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  // After a category pick rewrites the composer text, park the caret just past
  // the inserted "@kind:" so typing filters that category (applied in an effect
  // once the controlled value has re-rendered).
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  // Escape closes the menu without clearing the typed "/query" text (design
  // 6.1); typing again reopens it -- tracked separately from `value` so
  // Escape's effect does not depend on rewriting the textarea's contents.
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [envOpen, setEnvOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [attachments, setAttachments] = useState<PickedAttachmentWire[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const envTriggerRef = useRef<HTMLButtonElement>(null)
  const addMenuBtnRef = useRef<HTMLButtonElement>(null)
  // Anchors the slash/mention/resume Popovers -- they should span the full
  // composer width (matchAnchorWidth), not just the trigger that opened them.
  const composerRef = useRef<HTMLDivElement>(null)
  const voice = useVoiceRecorder()

  const modelReady = refConfigured(providers, modelRef)
  const showNotice = providers.length > 0 && !modelReady
  // The pill makes trailing text optional (design 5.2): a bare workflow/goal
  // send is valid, only an empty composer with no pill is not.
  const hasContent =
    value.trim() !== '' || command !== null || mentions.length > 0 || attachments.length > 0

  // F3: the env picker is interactive only for a not-yet-started conversation
  // (Home / a fresh convo with no events). Once a conversation has run, its
  // environment is locked; the pill then reads from the convo's own
  // environment rather than the shared draft field.
  const envLocked = activeConvo ? activeConvo.eventsLen > 0 : false
  const displayEnv = envLocked && activeConvo ? activeConvo.environment : composerEnvironment
  const workspacePath = useAppStore((s) => s.workspacePath)
  const [worktreeAvailable, setWorktreeAvailable] = useState(false)

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

  // The @ menu and the / menu never render together (the / menu only opens
  // when value[0] === '/'); guard the @ menu off when the / menu or resume
  // picker is open, since both popovers share the spot above the composer.
  const mentionOpen = mentionQuery !== null && !menuOpen && !resumePickerOpen
  // Antigravity's category-first flow: a bare `@` shows the category chooser
  // (Files/Rules/Conversations); choosing one inserts `@<kind>:` and the menu
  // then drills into that category's items. parseMentionQuery splits the token.
  const mentionParsed = mentionQuery ? parseMentionQuery(mentionQuery.query) : null
  const mentionRows: MentionRow[] =
    mentionOpen && mentionParsed
      ? buildMentionRows({
          category: mentionParsed.category,
          sub: mentionParsed.sub,
          files: fileSuggestions,
          rules: manualRules,
          // mentionConvoEntries is a flat [id, title, id, title, ...] array
          // scoped from the store above (see useShallow selector).
          conversations: (() => {
            const rows: { id: string; title: string }[] = []
            for (let i = 0; i < mentionConvoEntries.length; i += 2) {
              rows.push({ id: mentionConvoEntries[i], title: mentionConvoEntries[i + 1] })
            }
            return rows
          })(),
          connectors: mcpConnectors,
          skills: manualSkills
        })
      : []
  const mentionHeader =
    mentionParsed && mentionParsed.category
      ? {
          file: 'Files',
          rule: 'Rules',
          conversation: 'Conversations',
          connector: 'Connectors',
          skill: 'Skills'
        }[mentionParsed.category]
      : null
  const safeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionRows.length - 1))

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '52px'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [value])

  // F3: New Worktree is offerable only for a git-repo folder (git present +
  // repo discovered). When the current workspace can't host a worktree, gray the
  // option out and never leave a stale 'worktree' selection standing.
  useEffect(() => {
    if (!showEnvRow) return undefined
    let live = true
    const probe = workspacePath
      ? window.bearcode.worktree.available(workspacePath)
      : Promise.resolve(false)
    void probe.then((ok) => {
      if (!live) return
      setWorktreeAvailable(ok)
      if (!ok) setComposerEnvironment('local')
    })
    return () => {
      live = false
    }
  }, [showEnvRow, workspacePath, setComposerEnvironment])

  // Re-fetched on menu open only (menu-open paced, matching the loader's own
  // cache design), not on every keystroke while it stays open.
  useEffect(() => {
    if (menuOpen) refreshCommands()
  }, [menuOpen, refreshCommands])

  useEffect(() => {
    if (mentionOpen) {
      refreshManualRules()
      refreshMcpConnectors()
      refreshManualSkills()
    }
  }, [mentionOpen, refreshManualRules, refreshMcpConnectors, refreshManualSkills])
  useEffect(() => {
    // Only fetch file suggestions once the user has drilled into @file:.
    if (mentionParsed?.category === 'file') suggestFiles(mentionParsed.sub)
  }, [mentionParsed?.category, mentionParsed?.sub, suggestFiles])

  // Apply a caret parked by a category pick, after the controlled textarea
  // value has re-rendered, so typing continues right after the "@kind:".
  useEffect(() => {
    if (pendingCaret != null && taRef.current) {
      taRef.current.focus()
      taRef.current.setSelectionRange(pendingCaret, pendingCaret)
      setPendingCaret(null)
    }
  }, [pendingCaret, value])

  const selectMentionRow = (row: MentionRow): void => {
    if (!mentionQuery) return
    const before = value.slice(0, mentionQuery.start)
    const after = value.slice(mentionQuery.start + 1 + mentionQuery.query.length)
    if (row.type === 'category') {
      // Drill in: replace the bare "@query" with "@kind:" and keep the menu
      // open (now in item mode); park the caret just after the colon.
      const prefix = mentionCategoryPrefix(row.kind)
      setValue(before + '@' + prefix + after)
      setMentionQuery({ start: mentionQuery.start, query: prefix })
      setMentionIndex(0)
      setPendingCaret(mentionQuery.start + 1 + prefix.length)
      return
    }
    // Item pick: drop the "@kind:query" trigger text; the pill row shows it.
    const ref = row.suggestion.ref
    setValue(before + after)
    setMentions((m) =>
      m.some((x) => x.kind === ref.kind && x.name === ref.name) ? m : [...m, ref]
    )
    setMentionQuery(null)
    setMentionIndex(0)
  }

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

  // + "Add Context" (design 8). Media ingests images for the active
  // conversation -- OR, on Home (no conversationId yet), under a lazily-minted
  // draft conversation id that startFromHome later creates the conversation
  // as (store.ts ensureDraftConvoId), so Media works before the first send.
  // Mentions opens the @ menu; Actions opens the / menu; Browser drops the
  // /browser command chip. The @/ menus already key off the textarea contents (mentionQuery /
  // value[0] === '/'), so those two just seed + focus.
  const onMedia = async (): Promise<void> => {
    setAddMenuOpen(false)
    const { picked, errors } = await pickAttachments(attachments.length)
    if (picked.length > 0) setAttachments((cur) => [...cur, ...picked])
    if (errors.length > 0) showToast(errors[0])
  }
  const onMentions = (): void => {
    setAddMenuOpen(false)
    const ta = taRef.current
    const caret = ta?.selectionStart ?? value.length
    const next = value.slice(0, caret) + '@' + value.slice(caret)
    setValue(next)
    setMentionQuery({ start: caret, query: '' })
    setMentionIndex(0)
    setPendingCaret(caret + 1)
  }
  const onActions = (): void => {
    setAddMenuOpen(false)
    if (command !== null) return // one command per turn; the pill already holds it
    setValue('/')
    setMenuDismissed(false)
    setPendingCaret(1)
  }
  // F4: Browser drops the /browser command chip (routes the turn through the
  // browser subagent). One command per turn, so it no-ops if a pill is present.
  const onBrowser = (): void => {
    setAddMenuOpen(false)
    if (command !== null) return
    setCommand({ name: 'browser', kind: 'builtin' })
  }

  const addContextGroups: MenuGroup[] = [
    {
      items: [
        { value: 'media', label: 'Media', icon: <IconImage size={16} />, title: 'Attach images' },
        { value: 'mentions', label: 'Mentions', icon: <IconAt size={16} /> },
        { value: 'actions', label: 'Actions', icon: <IconSlash size={16} /> },
        { value: 'browser', label: 'Browser', icon: <IconGlobe size={16} /> }
      ]
    }
  ]
  const onAddContextSelect = (v: string): void => {
    if (v === 'media') void onMedia()
    else if (v === 'mentions') onMentions()
    else if (v === 'actions') onActions()
    else if (v === 'browser') onBrowser()
  }

  // Splice a voice transcript into the composer at the caret, reusing the
  // pendingCaret mechanism to park the caret just past the inserted text once
  // the controlled value re-renders. Read from taRef.current.value so a stale
  // closure over `value` can't clobber text typed while recording.
  const insertTranscript = (text: string): void => {
    const ta = taRef.current
    const cur = ta ? ta.value : value
    const caret = ta?.selectionStart ?? cur.length
    const next = cur.slice(0, caret) + text + cur.slice(caret)
    setValue(next)
    setMenuDismissed(false)
    setPendingCaret(caret + text.length)
  }

  // ⌃M / mic click toggles capture: idle → record, recording → stop+transcribe.
  // Ignored mid-transcription so a stray press can't double-fire.
  const toggleRecord = (): void => {
    if (voice.status === 'transcribing') return
    if (voice.status === 'recording') {
      void voice.stop().then((text) => {
        if (text && text.trim() !== '') insertTranscript(text)
      })
    } else {
      void voice.start()
    }
  }

  const submit = (): void => {
    if (!hasContent || running || !modelReady) return
    const text = value.trim()
    const sentCommand = command
    const sentMentions = mentions
    const sentAttachments = attachments.map((a) => a.ref)
    setValue('')
    setCommand(null)
    setMentions([])
    setAttachments([])
    setMentionQuery(null)
    onSend(text, sentCommand, sentMentions, sentAttachments)
  }

  return (
    <div
      className={
        'composer' +
        (modelRef === URSA_MODEL_REF
          ? ' composer--ursa'
          : modelRef === URSUS_MODEL_REF
            ? ' composer--ursus'
            : '')
      }
      ref={composerRef}
    >
      {showNotice ? (
        <div className="composer-notice">
          No API key for the selected model.{' '}
          <span className="notice-link" onClick={() => openSettings('providers')}>
            Open Settings
          </span>
        </div>
      ) : null}
      {command ? (
        <div className="command-pill-row">
          <span className="command-pill">
            /{command.name}
            <Hint label="Remove command" side="top">
              <button
                type="button"
                className="pill-x"
                aria-label="Remove command"
                onClick={() => setCommand(null)}
              >
                <IconClose size={11} />
              </button>
            </Hint>
          </span>
        </div>
      ) : null}
      {mentions.length > 0 ? (
        <div className="command-pill-row">
          {mentions.map((m, i) => (
            <span className="command-pill" key={`${m.kind}:${m.name}:${i}`}>
              @{m.name}
              <Hint label="Remove mention" side="top">
                <button
                  type="button"
                  className="pill-x"
                  aria-label="Remove mention"
                  onClick={() => setMentions((cur) => cur.filter((_, idx) => idx !== i))}
                >
                  <IconClose size={11} />
                </button>
              </Hint>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="attachment-pill-row">
          {attachments.map((a, i) => {
            const kind = a.ref.kind ?? 'image'
            const badge = attachmentBadge(a.ref.name, a.ref.mime)
            // Only a genuine truncation warning survives to the chip face; a
            // pick-time "<BADGE>[ · reason]" notice is otherwise dropped now
            // that the colored badge itself conveys the file type.
            const truncationNotice = a.notice && /truncat/i.test(a.notice) ? a.notice : null
            return (
              <Hint label={a.ref.name} side="top" key={`${a.ref.id}:${i}`}>
                <span
                  className={`attachment-pill${kind === 'image' ? '' : ' attachment-pill-file'}`}
                >
                  {kind === 'image' ? (
                    <img className="attachment-thumb" src={a.previewDataUrl} alt={a.ref.name} />
                  ) : (
                    <span className={`attachment-type-badge ${badge.colorClass}`}>
                      {badge.label}
                    </span>
                  )}
                  <span className="attachment-name">{a.ref.name}</span>
                  {truncationNotice ? (
                    <span className="attachment-note">{truncationNotice}</span>
                  ) : null}
                  <Hint label="Remove attachment" side="top">
                    <button
                      type="button"
                      className="pill-x"
                      aria-label="Remove attachment"
                      onClick={() => setAttachments((cur) => cur.filter((_, idx) => idx !== i))}
                    >
                      <IconClose size={11} />
                    </button>
                  </Hint>
                </span>
              </Hint>
            )
          })}
        </div>
      ) : null}
      {showEnvRow ? (
        <div className="env-row">
          <div className="env-picker">
            <button
              ref={envTriggerRef}
              className="pill-btn"
              onClick={() => setEnvOpen((o) => !o)}
              disabled={envLocked}
            >
              {displayEnv === 'worktree' ? <IconGitBranch /> : <IconMonitor />}
              <span>{displayEnv === 'worktree' ? 'New Worktree' : 'Local'}</span>
              {!envLocked ? (
                <span className="chev">
                  <IconChevronDown />
                </span>
              ) : null}
            </button>
            <Popover
              anchorRef={envTriggerRef}
              open={envOpen && !envLocked}
              onClose={() => setEnvOpen(false)}
              placement="top-start"
            >
              <div className="menu menu--in-popover env-menu">
                <div
                  className={'menu-item' + (composerEnvironment === 'local' ? ' selected' : '')}
                  onClick={() => {
                    setComposerEnvironment('local')
                    setEnvOpen(false)
                  }}
                >
                  <IconMonitor size={16} />
                  <span>Local</span>
                  {composerEnvironment === 'local' ? <span className="check">✓</span> : null}
                </div>
                <div
                  className={
                    'menu-item' +
                    (composerEnvironment === 'worktree' ? ' selected' : '') +
                    (worktreeAvailable ? '' : ' disabled')
                  }
                  onClick={() => {
                    if (!worktreeAvailable) return
                    setComposerEnvironment('worktree')
                    setEnvOpen(false)
                  }}
                >
                  <IconGitBranch size={16} />
                  <span>New Worktree</span>
                  {composerEnvironment === 'worktree' ? <span className="check">✓</span> : null}
                </div>
                <div className="env-hint">Worktrees are available for Git repositories</div>
              </div>
            </Popover>
          </div>
        </div>
      ) : null}
      <textarea
        ref={taRef}
        rows={1}
        placeholder="Ask anything, @ to mention, / for actions"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          const next = e.target.value
          setValue(next)
          setMenuDismissed(false)
          setMentionQuery(activeMentionQuery(next, e.target.selectionStart ?? next.length))
          setMentionIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
            e.preventDefault()
            toggleRecord()
            return
          }
          if (mentionOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMentionIndex((i) => Math.min(i + 1, Math.max(0, mentionRows.length - 1)))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMentionIndex((i) => Math.max(i - 1, 0))
              return
            }
            // Only intercept Enter when there is a row to pick; with zero
            // matches, let it fall through to send the turn.
            if (e.key === 'Enter' && !e.shiftKey && mentionRows.length > 0) {
              e.preventDefault()
              const row = mentionRows[safeMentionIndex]
              if (row) selectMentionRow(row)
              return
            }
            // Escape is handled by the Popover wrapping this menu
            // (click-outside/Esc/scroll dismissal).
          }
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
            // Escape is handled by the Popover wrapping this menu
            // (click-outside/Esc/scroll dismissal).
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
          if (
            e.key === 'Backspace' &&
            command === null &&
            mentions.length > 0 &&
            value === '' &&
            e.currentTarget.selectionStart === 0 &&
            e.currentTarget.selectionEnd === 0
          ) {
            e.preventDefault()
            setMentions((m) => m.slice(0, -1))
            return
          }
          if (
            e.key === 'Backspace' &&
            command === null &&
            mentions.length === 0 &&
            attachments.length > 0 &&
            value === '' &&
            e.currentTarget.selectionStart === 0 &&
            e.currentTarget.selectionEnd === 0
          ) {
            e.preventDefault()
            setAttachments((a) => a.slice(0, -1))
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-controls">
        <div className="controls-left">
          <div className="add-context">
            <Hint label="Add context" side="top" disabled={addMenuOpen}>
              <button
                ref={addMenuBtnRef}
                className="icon-btn"
                aria-label="Add context"
                onClick={() => setAddMenuOpen((o) => !o)}
              >
                <IconPlus />
              </button>
            </Hint>
            <Menu
              anchorRef={addMenuBtnRef}
              open={addMenuOpen}
              onClose={() => setAddMenuOpen(false)}
              groups={addContextGroups}
              onSelect={onAddContextSelect}
              placement="top-start"
              ariaLabel="Add context"
            />
          </div>
          <ModePicker />
          <Hint
            label={voice.status === 'recording' ? 'Stop recording' : 'Voice input'}
            keys="⌃M"
            side="top"
          >
            <button
              className={`icon-btn mic-btn${voice.status === 'recording' ? ' recording' : ''}${
                voice.status === 'transcribing' ? ' transcribing' : ''
              }`}
              disabled={voice.status === 'transcribing'}
              aria-label={voice.status === 'recording' ? 'Stop recording (⌃M)' : 'Voice input (⌃M)'}
              onClick={toggleRecord}
            >
              <IconMic />
            </button>
          </Hint>
        </div>
        <div className="controls-right">
          <ContextMeter />
          <ModelPicker />
          {/* Effort is meaningless for a router: BOTH router conversations swap
              the Effort control for the per-conversation Mode picker (Code /
              Council / Deep Research). Concrete models keep EffortPicker as-is. */}
          {modelRef === URSA_MODEL_REF ? (
            <UrsaModePicker />
          ) : modelRef === URSUS_MODEL_REF ? (
            <UrsaModePicker router="ursus" />
          ) : (
            <EffortPicker />
          )}
          {running ? (
            <Hint label="Stop" side="top">
              <button className="icon-btn send-btn stop" aria-label="Stop" onClick={onStop}>
                <IconStop />
              </button>
            </Hint>
          ) : hasContent && modelReady ? (
            <Hint label="Send" side="top">
              <button className="icon-btn send-btn" aria-label="Send" onClick={submit}>
                <IconArrowUp />
              </button>
            </Hint>
          ) : null}
        </div>
      </div>
      {voice.error ? <div className="composer-voice-error">{voice.error}</div> : null}
      {/* These three are caret-driven autocompletes, not click-trigger
          dropdowns -- their keyboard nav stays owned by the textarea's
          onKeyDown above. Popover here only supplies shared positioning
          (anchored + width-matched to the whole composer), animation, and
          dismissal (Esc/outside-click/scroll), replacing the old
          `.slash-menu-wrap` absolute-position + hand-rolled dismiss code. */}
      <Popover
        anchorRef={composerRef}
        open={menuOpen}
        onClose={() => setMenuDismissed(true)}
        placement="top-start"
        matchAnchorWidth
      >
        <SlashMenu
          entries={filtered}
          highlightedIndex={safeIndex}
          onHighlight={setHighlightedIndex}
          onSelect={selectEntry}
        />
      </Popover>
      <Popover
        anchorRef={composerRef}
        open={mentionOpen}
        onClose={() => setMentionQuery(null)}
        placement="top-start"
        matchAnchorWidth
      >
        <MentionMenu
          rows={mentionRows}
          header={mentionHeader}
          highlightedIndex={safeMentionIndex}
          onHighlight={setMentionIndex}
          onSelect={selectMentionRow}
        />
      </Popover>
      <Popover
        anchorRef={composerRef}
        open={resumePickerOpen}
        onClose={() => setResumePickerOpen(false)}
        placement="top-start"
        matchAnchorWidth
      >
        <ResumePicker />
      </Popover>
    </div>
  )
}
