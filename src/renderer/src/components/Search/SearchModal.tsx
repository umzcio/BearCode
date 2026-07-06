import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { IconSearch, IconFolder, IconClose } from '../icons'
import { searchEntries, type SearchEntry } from './searchEntries'
import './SearchModal.css'

// Gate the modal on `searchOpen` so the inner content mounts fresh each time it
// opens. Mounting-fresh (rather than resetting query/highlighted inside an
// effect) is what keeps each open starting from a blank, top-highlighted state.
export function SearchModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.searchOpen)
  if (!open) return null
  return <SearchModalContent />
}

function SearchModalContent(): React.JSX.Element {
  const close = useAppStore((s) => s.closeSearch)
  const conversations = useAppStore((s) => s.conversations)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const projects = useAppStore((s) => s.projects)
  const openConvo = useAppStore((s) => s.openConvo)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const convos = convoOrder.map((id) => conversations[id]).filter((c): c is NonNullable<typeof c> => c != null)
    return searchEntries(query, convos, projects)
  }, [query, conversations, convoOrder, projects])

  useEffect(() => {
    // focus after mount
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  const select = (entry: SearchEntry | undefined): void => {
    if (!entry) return
    if (entry.kind === 'conversation') {
      close()
      openConvo(entry.id)
      return
    }
    // Project: open its most-recent conversation, else just close.
    const inProject = convoOrder
      .map((id) => conversations[id])
      .filter((c): c is NonNullable<typeof c> => c != null && c.projectId === entry.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    close()
    if (inProject[0]) openConvo(inProject[0].id)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted((h) => Math.min(h + 1, Math.max(0, results.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        select(results[Math.min(highlighted, results.length - 1)])
      }
    }
    const t = setTimeout(() => window.addEventListener('keydown', onKey), 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [results, highlighted])

  return (
    <div className="search-backdrop" onClick={close}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search chats and projects"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlighted(0)
            }}
          />
          <button className="chrome-btn" title="Close" onClick={close}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-empty">No matches</div>
          ) : (
            results.map((entry, i) => (
              <div
                key={entry.kind + ':' + entry.id}
                className={'search-item' + (i === highlighted ? ' highlighted' : '')}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => select(entry)}
              >
                <span className={'search-kind ' + entry.kind}>
                  {entry.kind === 'project' ? <IconFolder /> : <span className="search-dot" />}
                </span>
                <div className="search-item-main">
                  <span className="search-item-title">{entry.title}</span>
                  <span className="search-item-sub">{entry.subtitle}</span>
                </div>
                <span className="search-item-age">{relativeAge(entry.updatedAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
