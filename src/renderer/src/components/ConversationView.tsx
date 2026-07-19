import { useEffect, useRef, useState } from 'react'
import type { AttachmentRef } from '@shared/types'
import { useAppStore, workedSecondsByTurn, modelDisplay } from '../state/store'
import { Composer } from './Composer/Composer'
import { RunStatusBar } from './RunStatusBar/RunStatusBar'
import { WorktreeBar } from './Worktree/WorktreeBar'
import { WorkedGroup } from './events/WorkedGroup'
import { ToolStep, PinnedApprovalArea } from './events/ToolStep'
import { AssistantText } from './events/AssistantText'
import { ArtifactCard } from './events/ArtifactCard'
import { DiffCard } from './events/DiffCard'
import { SourcesList } from './events/SourcesList'
import { ErrorCard } from './events/ErrorCard'
import { CompactionMarker } from './events/CompactionMarker'
import { IconCopy, IconThumbsDown, IconThumbsUp } from './icons'
import { Hint } from './Hint'
import { messageTimestamp } from '../lib/time'
import { attachmentBadge } from '../lib/attachmentBadge'
import { groupTurnsIncremental, type TranscriptState } from '../lib/transcript'
import './ConversationView.css'

// A transcript attachment pill (Task 7). A reloaded transcript only carries
// the persisted AttachmentRef (id/name/mime) -- never bytes -- so the real
// thumbnail is fetched lazily over `bearcode:attachments:read`, which reads
// the bytes back from userData main-side (convId comes from this open
// conversation's context, never from the ref itself; see ipc.ts). Renders
// the name-only pill immediately and fills in the thumbnail once the read
// resolves (or stays name-only if the file is gone).
function AttachmentPill({
  convoId,
  attachment
}: {
  convoId: string
  attachment: AttachmentRef
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  // Back-compat: pre-D5 persisted refs have no `kind` -- default to 'image'
  // (see AttachmentKind doc in shared/types.ts). Never assume kind is present.
  const kind = attachment.kind ?? 'image'
  const isImage = kind === 'image'
  const badge = attachmentBadge(attachment.name, attachment.mime)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    void window.bearcode.attachments.read(convoId, attachment.id).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [convoId, attachment.id, isImage])
  return (
    <Hint label={attachment.name} side="top">
      <span className="msg-command-pill msg-attachment-pill">
        {isImage ? (
          src ? (
            <img className="msg-attachment-thumb" src={src} alt={attachment.name} />
          ) : null
        ) : (
          <span className={`msg-attachment-type-badge ${badge.colorClass}`}>{badge.label}</span>
        )}
        <span className="msg-attachment-name">{attachment.name}</span>
      </span>
    </Hint>
  )
}

export function ConversationView({ convoId }: { convoId: string }): React.JSX.Element {
  const convo = useAppStore((s) => s.conversations[convoId])
  const providers = useAppStore((s) => s.providers)
  const send = useAppStore((s) => s.send)
  const cancelRun = useAppStore((s) => s.cancelRun)
  const retryRun = useAppStore((s) => s.retryRun)
  const showToast = useAppStore((s) => s.showToast)
  // F1 jump-to-match: the event a content-search hit wants to land on, the full
  // match set for the next/prev navigator, and the actions to walk/clear it.
  const focusEventId = useAppStore((s) => s.focusEventId)
  const focusMatches = useAppStore((s) => s.focusMatches)
  const clearFocusEvent = useAppStore((s) => s.clearFocusEvent)
  const stepFocus = useAppStore((s) => s.stepFocus)
  const setFocusMatches = useAppStore((s) => s.setFocusMatches)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Records the focusEventId whose jump has already fired, so the effect below
  // scrolls+highlights each id exactly ONCE. Without this, the effect (which
  // depends on convo.events so it can catch the async-load case) would re-fire
  // on every streamed event of a follow-up turn, re-pinning the transcript to
  // the old match and re-flashing the highlight.
  const consumedFocusRef = useRef<string | null>(null)

  const running = convo.runState === 'running' || convo.runState === 'awaiting-approval'
  const transcriptRef = useRef<TranscriptState | null>(null)
  // Deliberate derive-from-previous-render pattern (audit H-9): reading and
  // immediately overwriting the ref during render is idempotent for identical
  // inputs (groupTurnsIncremental returns `prev` unchanged when convo.events
  // is referentially the same), so this is safe under StrictMode's double-
  // render and does not leak state across renders the way ordinary ref
  // mutation would. eslint-plugin-react-hooks's newer react-hooks/refs rule
  // flags any ref read/write during render on principle; disabled here with
  // rationale rather than restructuring into an effect (which would drop a
  // render and reintroduce the unmemoized full-conversation flash this task
  // exists to fix).
  // eslint-disable-next-line react-hooks/refs
  const transcript = groupTurnsIncremental(transcriptRef.current, convo.events)
  // eslint-disable-next-line react-hooks/refs
  transcriptRef.current = transcript
  const items = transcript.items
  // The last *turn* is the live one; compaction markers never count as "last".
  const lastTurnIdx = items.reduce((acc, it, idx) => (it.kind === 'turn' ? idx : acc), -1)

  // The first pending approval, pinned above the composer so the user never
  // has to scroll up through a long streamed answer to find the card (a live
  // complaint, twice). Renders the SAME ToolStep the transcript shows inline,
  // wrapped in PinnedApprovalArea so hotkeys/anchor/number chips stay unique
  // to the inline copy (see ToolStep.tsx).
  const firstPendingCall = convo.events.find(
    (e) => e.type === 'tool_call' && e.approvalState === 'pending'
  )

  const jumpToApproval = (): void => {
    document
      .getElementById('pending-approval-card')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [convo.events])

  // F1: when a content-search hit points here, scroll the matching event into
  // view and flash a transient highlight. The class is toggled imperatively on
  // the DOM node (never via React state) so it survives streaming re-renders --
  // the row's JSX className is constant, so React won't clobber the added class.
  // Runs after the auto-scroll-to-bottom effect above so it wins on open.
  //
  // The common history-search path opens a conversation that is NOT yet loaded:
  // `conversations.get(id)` resolves asynchronously, so on the first render the
  // transcript is empty and the target anchor does not exist yet. We must NOT
  // clear focus then -- that would permanently abort the jump. Instead we gate
  // on `convo.loaded` and depend on `convo.events`, so the effect re-runs once
  // the events arrive and only clears when the target is genuinely absent from
  // a loaded transcript (e.g. compacted away).
  useEffect(() => {
    if (!focusEventId) {
      // No pending jump -- forget the last consumed id so a future jump to the
      // SAME event id (e.g. re-running the same search) fires again.
      consumedFocusRef.current = null
      return
    }
    // Events haven't loaded yet; wait for them (this effect re-runs when
    // convo.events / convo.loaded change). Clearing now would kill the jump.
    if (!convo.loaded) return
    // Already jumped for this id: do NOT re-scroll/re-highlight when convo.events
    // changes for the same focusEventId (streamed events on a follow-up turn).
    if (consumedFocusRef.current === focusEventId) return
    // Scan by dataset rather than an attribute selector so arbitrary event ids
    // never need escaping. A single anchor may advertise more than one id
    // (space-joined) -- e.g. a paired tool_call+tool_result ToolStep -- so match
    // against the whole set. Event ids never contain spaces.
    const el = Array.from(scrollRef.current?.querySelectorAll('[data-event-id]') ?? []).find((n) =>
      ((n as HTMLElement).dataset.eventId ?? '').split(' ').includes(focusEventId)
    )
    if (!el) {
      // Loaded, but the target isn't in the rendered transcript (e.g. compacted
      // away). Abort the jump so it can't fire spuriously later; never throw.
      clearFocusEvent()
      return
    }
    // Mark this id consumed before firing so a re-run (from a subsequent
    // convo.events change) for the same id short-circuits above.
    consumedFocusRef.current = focusEventId
    el.scrollIntoView({ block: 'center' })
    el.classList.add('event-focus-highlight')
    // Respect reduce-motion: skip the timed fade (the CSS also drops the
    // animation), leaving a static highlight until focus moves away.
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timer = reduce
      ? undefined
      : window.setTimeout(() => el.classList.remove('event-focus-highlight'), 1600)
    return () => {
      if (timer) window.clearTimeout(timer)
      el.classList.remove('event-focus-highlight')
    }
  }, [focusEventId, convo.loaded, convo.events, clearFocusEvent])

  // F1: searchHistory ranks matches by bm25, but the next/prev navigator should
  // walk them in transcript order so "N of M" advances monotonically down the
  // conversation. Once events are loaded, reorder focusMatches into document
  // order. Guarded to a single write: after sorting, the order matches and no
  // further set fires, so this settles without looping.
  useEffect(() => {
    if (focusMatches.length < 2 || !convo.loaded) return
    const pos = new Map(convo.events.map((e, i) => [e.id, i] as const))
    const ordered = [...focusMatches].sort(
      (a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity)
    )
    if (ordered.some((id, i) => id !== focusMatches[i])) setFocusMatches(ordered)
  }, [focusMatches, convo.loaded, convo.events, setFocusMatches])

  const focusIdx = focusEventId ? focusMatches.indexOf(focusEventId) : -1

  return (
    <div className="convo-view">
      {focusMatches.length > 1 ? (
        <div className="focus-nav" role="status" aria-label="Search match navigator">
          <Hint label="Previous match" side="bottom" disabled={focusIdx <= 0}>
            <button
              className="icon-btn"
              aria-label="Previous match"
              onClick={() => stepFocus(-1)}
              disabled={focusIdx <= 0}
            >
              ‹
            </button>
          </Hint>
          <span className="focus-nav-count">
            {Math.max(0, focusIdx) + 1} of {focusMatches.length}
          </span>
          <Hint label="Next match" side="bottom" disabled={focusIdx >= focusMatches.length - 1}>
            <button
              className="icon-btn"
              aria-label="Next match"
              onClick={() => stepFocus(1)}
              disabled={focusIdx >= focusMatches.length - 1}
            >
              ›
            </button>
          </Hint>
        </div>
      ) : null}
      <div className="convo-scroll" ref={scrollRef}>
        <div className="convo-inner">
          {items.map((item, i) => {
            if (item.kind === 'compaction') {
              return <CompactionMarker key={item.id} summarizedCount={item.summarizedCount} />
            }
            const turn = item.turn
            const isLast = i === lastTurnIdx
            // Live for the whole active turn (not just until prose starts), so
            // the working indicator + bear persist while the model keeps going.
            const hasText = turn.texts.some((t) => t.text.length > 0)
            const live = isLast && running
            const streaming = isLast && running && hasText
            return (
              <div key={turn.user.id} className="turn-pair">
                <div className="msg-user-wrap" data-event-id={turn.user.id}>
                  <div className="msg-user">
                    {turn.user.command ? (
                      <span className="msg-command-pill">/{turn.user.command.name}</span>
                    ) : null}
                    {turn.user.mentions?.map((m, i) => (
                      <span className="msg-command-pill" key={`${m.kind}:${m.name}:${i}`}>
                        @{m.name}
                      </span>
                    ))}
                    {turn.user.attachments?.map((a, i) => (
                      <AttachmentPill key={`att:${a.id}:${i}`} convoId={convoId} attachment={a} />
                    ))}
                    {turn.user.text}
                  </div>
                  <div className="msg-user-meta">
                    {turn.user.createdAt ? (
                      <span className="msg-time">{messageTimestamp(turn.user.createdAt)}</span>
                    ) : null}
                    <Hint label="Copy" side="top">
                      <button
                        className="icon-btn"
                        aria-label="Copy"
                        onClick={() => {
                          void window.bearcode.clipboard
                            .write(turn.user.text)
                            .then(() => showToast('Copied'))
                        }}
                      >
                        <IconCopy />
                      </button>
                    </Hint>
                  </div>
                </div>
                <div className="agent-turn">
                  {turn.steps.length > 0 || live ? (
                    <WorkedGroup
                      steps={turn.steps}
                      live={live}
                      startedAt={convo.startedAt}
                      workedSeconds={workedSecondsByTurn.get(turn.user.id)}
                      convoId={convoId}
                    />
                  ) : null}
                  {turn.artifacts.map((a) => (
                    <ArtifactCard key={a.id} event={a} />
                  ))}
                  {turn.texts.map((t) =>
                    t.text.length > 0 ? (
                      <div key={t.id} data-event-id={t.id}>
                        <AssistantText text={t.text} streaming={streaming} convoId={convoId} />
                      </div>
                    ) : null
                  )}
                  {turn.diffs.map((d) => (
                    <DiffCard key={d.id} event={d} />
                  ))}
                  {turn.turnMeta?.citations ? (
                    <SourcesList citations={turn.turnMeta.citations} />
                  ) : null}
                  {turn.errors.map((e) => (
                    <ErrorCard
                      key={e.id}
                      message={e.message}
                      recoverable={e.recoverable}
                      onRetry={() => retryRun(convoId)}
                    />
                  ))}
                  {turn.turnMeta?.ursaRole ? (
                    <span className="msg-ursa-badge">
                      {turn.turnMeta.ursaRole} ·{' '}
                      {
                        modelDisplay(providers, `${turn.turnMeta.provider}/${turn.turnMeta.model}`)
                          .name
                      }
                    </span>
                  ) : null}
                  {turn.done || turn.errors.length > 0 ? (
                    <div className="msg-actions">
                      <Hint label="Copy" side="top">
                        <button
                          className="icon-btn"
                          aria-label="Copy"
                          onClick={() => {
                            const text = turn.texts.map((t) => t.text).join('\n\n')
                            void window.bearcode.clipboard
                              .write(text)
                              .then(() => showToast('Copied'))
                          }}
                        >
                          <IconCopy />
                        </button>
                      </Hint>
                      <Hint label="Good response" side="top">
                        <button
                          className="icon-btn"
                          aria-label="Good response"
                          onClick={() => showToast('Noted')}
                        >
                          <IconThumbsUp />
                        </button>
                      </Hint>
                      <Hint label="Bad response" side="top">
                        <button
                          className="icon-btn"
                          aria-label="Bad response"
                          onClick={() => showToast('Noted')}
                        >
                          <IconThumbsDown />
                        </button>
                      </Hint>
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {firstPendingCall?.type === 'tool_call' ? (
        <div className="convo-status">
          <div className="convo-status-inner pinned-approval">
            <PinnedApprovalArea.Provider value={true}>
              <ToolStep call={firstPendingCall} convoId={convoId} />
            </PinnedApprovalArea.Provider>
          </div>
        </div>
      ) : null}
      <div className="convo-status">
        <div className="convo-status-inner">
          <RunStatusBar convoId={convoId} onJumpToApproval={jumpToApproval} />
        </div>
      </div>
      <WorktreeBar convoId={convoId} />
      <div className="convo-composer">
        <div className="composer-wrap">
          <Composer
            conversationId={convoId}
            onSend={(text, command, mentions, attachments) =>
              send(convoId, text, command, mentions, attachments)
            }
            running={running}
            onStop={() => cancelRun(convoId)}
          />
        </div>
      </div>
    </div>
  )
}
