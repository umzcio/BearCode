import type { CommandEntry } from '@shared/types'
import { IconLines, IconOverview } from '../icons'
import './SlashMenu.css'

interface SlashMenuProps {
  entries: CommandEntry[]
  highlightedIndex: number
  onHighlight(index: number): void
  onSelect(entry: CommandEntry): void
}

// The / menu (D2 design 6.1). Purely presentational: Composer owns the query,
// the open/closed state, and the highlighted index; this just renders rows
// and reports hover/click back up. Greyed rows (coming-soon or a parse/
// collision error) stay highlightable so their reason is readable, but a
// click on one is a no-op -- only Composer's Enter handling also needs to
// skip them, mirrored here for the mouse path.
export function SlashMenu({
  entries,
  highlightedIndex,
  onHighlight,
  onSelect
}: SlashMenuProps): React.JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="menu slash-menu">
        <div className="menu-empty">No matching commands.</div>
      </div>
    )
  }
  return (
    <div className="menu slash-menu">
      {entries.map((entry, i) => (
        // Keyed by kind AND name: a workflow colliding with a built-in keeps
        // the built-in's name (design 5.1, both rows render together), so
        // name alone would duplicate React keys. Highlighting is index-based
        // throughout, so no other row-identity logic needs the same fix.
        <div
          key={`${entry.kind}:${entry.name}`}
          className={
            'menu-item' +
            (i === highlightedIndex ? ' highlighted' : '') +
            (entry.status !== 'live' ? ' disabled' : '')
          }
          onMouseEnter={() => onHighlight(i)}
          onClick={() => {
            if (entry.status === 'live') onSelect(entry)
          }}
        >
          <span className="slash-item-icon">
            {entry.kind === 'builtin' ? <IconLines size={14} /> : <IconOverview size={14} />}
          </span>
          <div className="slash-item-main">
            <span className="slash-item-name">/{entry.name}</span>
            {entry.error ? (
              <span className="slash-item-error">{entry.error}</span>
            ) : entry.description ? (
              <span className="slash-item-desc">{entry.description}</span>
            ) : null}
          </div>
          {entry.status === 'coming-soon' && !entry.error ? (
            <span className="badge">soon</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
