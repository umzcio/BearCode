import { useEffect, useRef, useState } from 'react'
import type { AttachmentRef, Event } from '@shared/types'
import { useAppStore, workedSecondsByTurn } from '../state/store'
import { Composer } from './Composer/Composer'
import { RunStatusBar } from './RunStatusBar/RunStatusBar'
import { WorkedGroup } from './events/WorkedGroup'
import { AssistantText } from './events/AssistantText'
import { ArtifactCard } from './events/ArtifactCard'
import { DiffCard } from './events/DiffCard'
import { ErrorCard } from './events/ErrorCard'
import { CompactionMarker } from './events/CompactionMarker'
import { IconCopy, IconThumbsDown, IconThumbsUp } from './icons'
import { Hint } from './Hint'
import { messageTimestamp } from '../lib/time'
import { attachmentBadge } from '../lib/attachmentBadge'
import './ConversationView.css'

interface Turn {
  user: Extract<Event, { type: 'user_message' }>
  steps: Event[]
  texts: Extract<Event, { type: 'assistant_text' }>[]
  diffs: Extract<Event, { type: 'file_diff' }>[]
  artifacts: Extract<Event, { type: 'artifact' }>[]
  errors: Extract<Event, { type: 'error' }>[]
  done: boolean
}

// A transcript is a stream of turns interleaved with top-level markers. Today
// the only marker is `compaction` (auto-compaction folded the oldest messages
// into a summary); it sits between turns in stream order, like a divider.
type TranscriptItem =
  { kind: 'turn'; turn: Turn } | { kind: 'compaction'; id: string; summarizedCount: number }

function groupTurns(events: Event[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let current: Turn | null = null
  for (const ev of events) {
    if (ev.type === 'user_message') {
      current = {
        user: ev,
        steps: [],
        texts: [],
        diffs: [],
        artifacts: [],
        errors: [],
        done: false
      }
      // Push the live object by reference so later events mutating `current`
      // (steps/texts/done) are reflected in the rendered item.
      items.push({ kind: 'turn', turn: current })
    } else if (ev.type === 'compaction') {
      // Additive & optional: older streams never carry this, so nothing renders.
      items.push({ kind: 'compaction', id: ev.id, summarizedCount: ev.summarizedCount })
    } else if (current) {
      if (ev.type === 'thinking' || ev.type === 'tool_call' || ev.type === 'tool_result') {
        current.steps.push(ev)
      } else if (ev.type === 'assistant_text') {
        current.texts.push(ev)
      } else if (ev.type === 'file_diff') {
        current.diffs.push(ev)
      } else if (ev.type === 'artifact') {
        current.artifacts.push(ev)
      } else if (ev.type === 'error') {
        current.errors.push(ev)
      } else if (ev.type === 'turn_meta') {
        current.done = true
      }
    }
  }
  return items
}

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

  const running = convo.runState === 'running' || convo.runState === 'awaiting-approval'
  const items = groupTurns(convo.events)
  // The last *turn* is the live one; compaction markers never count as "last".
  const lastTurnIdx = items.reduce((acc, it, idx) => (it.kind === 'turn' ? idx : acc), -1)

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
    if (!focusEventId) return
    // Events haven't loaded yet; wait for them (this effect re-runs when
    // convo.events / convo.loaded change). Clearing now would kill the jump.
    if (!convo.loaded) return
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
          <button
            className="icon-btn"
            title="Previous match"
            onClick={() => stepFocus(-1)}
            disabled={focusIdx <= 0}
          >
            ‹
          </button>
          <span className="focus-nav-count">
            {Math.max(0, focusIdx) + 1} of {focusMatches.length}
          </span>
          <button
            className="icon-btn"
            title="Next match"
            onClick={() => stepFocus(1)}
            disabled={focusIdx >= focusMatches.length - 1}
          >
            ›
          </button>
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
                    <button
                      className="icon-btn"
                      title="Copy"
                      onClick={() => {
                        void navigator.clipboard.writeText(turn.user.text)
                        showToast('Copied')
                      }}
                    >
                      <IconCopy />
                    </button>
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
                  {turn.errors.map((e) => (
                    <ErrorCard
                      key={e.id}
                      message={e.message}
                      recoverable={e.recoverable}
                      onRetry={() => retryRun(convoId)}
                    />
                  ))}
                  {turn.done || turn.errors.length > 0 ? (
                    <div className="msg-actions">
                      <button
                        className="icon-btn"
                        title="Copy"
                        onClick={() => {
                          const text = turn.texts.map((t) => t.text).join('\n\n')
                          void navigator.clipboard.writeText(text)
                          showToast('Copied')
                        }}
                      >
                        <IconCopy />
                      </button>
                      <button
                        className="icon-btn"
                        title="Good response"
                        onClick={() => showToast('Noted')}
                      >
                        <IconThumbsUp />
                      </button>
                      <button
                        className="icon-btn"
                        title="Bad response"
                        onClick={() => showToast('Noted')}
                      >
                        <IconThumbsDown />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="convo-status">
        <div className="convo-status-inner">
          <RunStatusBar convoId={convoId} onJumpToApproval={jumpToApproval} />
        </div>
      </div>
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
