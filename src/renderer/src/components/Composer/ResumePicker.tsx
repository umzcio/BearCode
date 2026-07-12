import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import './SlashMenu.css'

// /resume's popover (D2 design 6.2): a pure UI action, no turn. Lists every
// known conversation (the sidebar's own data, no new IPC) sorted by
// updatedAt descending. Composer wraps this in a Popover (positioning,
// width-match, animation, and close-on-outside-click/Escape), mirroring the
// ModePicker idiom; this component only owns its own row highlight + the
// arrow/Enter keys Popover doesn't handle.
export function ResumePicker(): React.JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const setOpen = useAppStore((s) => s.setResumePickerOpen)
  const openConvo = useAppStore((s) => s.openConvo)
  const [highlighted, setHighlighted] = useState(0)

  const items = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted((h) => Math.min(h + 1, Math.max(0, items.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        const picked = items[highlighted]
        if (picked) {
          e.preventDefault()
          setOpen(false)
          openConvo(picked.id)
        }
      }
    }
    // Deferred by one tick on purpose: Composer's selectEntry('resume') flips
    // resumePickerOpen on the SAME native keydown event that is still
    // bubbling when this effect first runs on mount. Attaching synchronously
    // here would catch the tail of that opening event -- window sees the
    // Enter that opened the picker and immediately "confirms" the top row
    // (smoke-caught, D2 task-6-report.md Drill 3). A zero-delay timeout lets
    // the opening event finish its dispatch before we start listening.
    // (Escape/outside-click dismissal now lives on the wrapping Popover.)
    const timer = setTimeout(() => {
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [items, highlighted, setOpen, openConvo])

  if (items.length === 0) {
    return (
      <div className="menu slash-menu resume-picker">
        <div className="menu-empty">No conversations to resume yet.</div>
      </div>
    )
  }

  return (
    <div className="menu slash-menu resume-picker">
      {items.map((c, i) => (
        <div
          key={c.id}
          className={'menu-item' + (i === highlighted ? ' highlighted' : '')}
          onMouseEnter={() => setHighlighted(i)}
          onClick={() => {
            setOpen(false)
            openConvo(c.id)
          }}
        >
          <div className="slash-item-main">
            <span className="slash-item-name">{c.title}</span>
            <span className="slash-item-desc">{c.projectLabel}</span>
          </div>
          <span className="resume-item-time">{relativeAge(c.updatedAt)}</span>
        </div>
      ))}
    </div>
  )
}
