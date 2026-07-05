import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import './SlashMenu.css'

// /resume's popover (D2 design 6.2): a pure UI action, no turn. Lists every
// known conversation (the sidebar's own data, no new IPC) sorted by
// updatedAt descending. Composer positions this via the shared
// .slash-menu-wrap; this component only owns its own row highlight and
// close-on-outside-click/Escape, mirroring the ExecutionModePicker idiom.
export function ResumePicker(): React.JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const setOpen = useAppStore((s) => s.setResumePickerOpen)
  const openConvo = useAppStore((s) => s.openConvo)
  const rootRef = useRef<HTMLDivElement>(null)
  const [highlighted, setHighlighted] = useState(0)

  const items = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
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
    // resumePickerOpen (and, for the mouse path, SlashMenu's row click) on
    // the SAME native keydown/click event that is still bubbling when this
    // effect first runs on mount. Attaching synchronously here would catch
    // the tail of that opening event -- window sees the Enter that opened
    // the picker and immediately "confirms" the top row, or document sees
    // the opening click as an outside click and immediately closes it
    // (smoke-caught, D2 task-6-report.md Drill 3). A zero-delay timeout
    // lets the opening event finish its dispatch before we start listening.
    const timer = setTimeout(() => {
      document.addEventListener('click', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [items, highlighted, setOpen, openConvo])

  if (items.length === 0) {
    return (
      <div className="menu slash-menu resume-picker" ref={rootRef}>
        <div className="menu-empty">No conversations to resume yet.</div>
      </div>
    )
  }

  return (
    <div className="menu slash-menu resume-picker" ref={rootRef}>
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
