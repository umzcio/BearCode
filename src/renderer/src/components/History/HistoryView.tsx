// Full-page Conversation History (F1). Two modes off one search box:
//   - empty query  -> browse: all conversations, time-bucketed (groupByTime),
//     newest first, click a row to open it.
//   - non-empty     -> debounced FTS content search (history.search IPC),
//     ranked rows with a snippet; click jumps to + highlights the matched event
//     via openConvo(id, { focusEventId, focusMatches }) -- focusMatches carries
//     every hit in that conversation so the jump navigator can step across them.
// ⌘K opens this view (the old title-only Cmd-K search modal was removed — this
// full-text History superseded it).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryHit } from '@shared/types'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { groupByTime } from '../../lib/groupByTime'
import { IconSearch } from '../icons'
import { renderSnippet } from './snippet'
import './HistoryView.css'

function modelLabel(ref: string | null): string {
  if (!ref) return ''
  const slash = ref.indexOf('/')
  return slash === -1 ? ref : ref.slice(slash + 1)
}

// Wrapped so the (impure) clock read happens inside an imported function rather
// than directly in a render/useMemo body -- same shape as lib/time's relativeAge,
// which keeps the react-hooks purity lint clean.
function nowMs(): number {
  return Date.now()
}

export function HistoryView(): React.JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const openConvo = useAppStore((s) => s.openConvo)
  const [query, setQuery] = useState('')
  // Results tagged with the query they belong to, so we can show "Searching…"
  // for a stale/absent result without a synchronous setState inside the effect.
  const [result, setResult] = useState<{ query: string; hits: HistoryHit[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  const trimmed = query.trim()

  // Debounced content search. Empty query renders browse mode (no fetch).
  useEffect(() => {
    if (trimmed === '') return
    let cancelled = false
    const t = setTimeout(() => {
      void window.bearcode.history.search(trimmed).then((hits) => {
        if (!cancelled) setResult({ query: trimmed, hits })
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [trimmed])

  const groups = useMemo(() => {
    const convos = convoOrder
      .map((id) => conversations[id])
      .filter((c): c is NonNullable<typeof c> => c != null)
    return groupByTime(convos, nowMs())
  }, [conversations, convoOrder])

  const hits = result && result.query === trimmed ? result.hits : null

  return (
    <div className="history-view">
      <div className="history-search-row">
        <IconSearch size={16} />
        <input
          ref={inputRef}
          className="history-search-input"
          placeholder="Search conversation content"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="history-scroll">
        {trimmed === '' ? (
          groups.length === 0 ? (
            <div className="history-empty">No conversations yet</div>
          ) : (
            groups.map((group) => (
              <div className="history-bucket" key={group.bucket}>
                <div className="history-bucket-head">{group.bucket}</div>
                {group.items.map((convo) => {
                  // Prefer the loaded transcript's first user message; fall back
                  // to the DB-sourced preview so unopened conversations (empty
                  // in-memory events after a restart) still show a snippet.
                  const loadedPreview = convo.events.find((e) => e.type === 'user_message')
                  const preview =
                    loadedPreview && loadedPreview.type === 'user_message'
                      ? loadedPreview.text
                      : convo.preview
                  return (
                    <div
                      className="history-row"
                      key={convo.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openConvo(convo.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openConvo(convo.id)
                        }
                      }}
                    >
                      <div className="history-row-main">
                        <span className="history-row-title">{convo.title}</span>
                        {preview ? <span className="history-row-preview">{preview}</span> : null}
                      </div>
                      <div className="history-row-meta">
                        <span className="history-row-proj">{convo.projectLabel}</span>
                        {modelLabel(convo.modelRef) ? (
                          <span className="history-row-model">{modelLabel(convo.modelRef)}</span>
                        ) : null}
                        <span className="history-row-age">{relativeAge(convo.updatedAt)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))
          )
        ) : hits === null ? (
          <div className="history-empty">Searching…</div>
        ) : hits.length > 0 ? (
          hits.map((hit) => (
            <div
              className="history-hit"
              key={hit.eventId}
              role="button"
              tabIndex={0}
              onClick={() =>
                openConvo(hit.conversationId, {
                  focusEventId: hit.eventId,
                  // Derive the per-conversation match set (in ranked display
                  // order) from the current results so ConversationView's
                  // next/prev navigator can walk every hit in this conversation,
                  // not just the clicked one. A lone hit yields a single-element
                  // set (navigator stays hidden).
                  focusMatches: hits
                    .filter((h) => h.conversationId === hit.conversationId)
                    .map((h) => h.eventId)
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openConvo(hit.conversationId, {
                    focusEventId: hit.eventId,
                    focusMatches: hits
                      .filter((h) => h.conversationId === hit.conversationId)
                      .map((h) => h.eventId)
                  })
                }
              }}
            >
              <div className="history-hit-head">
                <span className="history-hit-title">{hit.title ?? 'Untitled conversation'}</span>
                <span className="history-hit-proj">{hit.projectLabel}</span>
                <span className="history-hit-age">{relativeAge(hit.updatedAt)}</span>
              </div>
              <div className="history-hit-snippet">{renderSnippet(hit.snippet)}</div>
            </div>
          ))
        ) : (
          <div className="history-empty">No matches</div>
        )}
      </div>
    </div>
  )
}
