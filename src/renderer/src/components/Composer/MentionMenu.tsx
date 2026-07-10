import type { MentionKind, MentionRow } from './mentionQuery'
import { IconFile, IconLines, IconHistory, IconChevronRight, IconBlocks } from '../icons'
import './SlashMenu.css'

interface MentionMenuProps {
  rows: MentionRow[]
  // Category label shown as a header once the user has drilled into a category
  // (null in the top-level category chooser). e.g. "Conversations".
  header: string | null
  highlightedIndex: number
  onHighlight(index: number): void
  onSelect(row: MentionRow): void
}

function KindIcon({ kind }: { kind: MentionKind }): React.JSX.Element {
  if (kind === 'file') return <IconFile size={14} />
  if (kind === 'conversation') return <IconHistory size={14} />
  if (kind === 'connector') return <IconBlocks size={14} />
  return <IconLines size={14} />
}

// The @ menu (D3 design 7, reworked to match Antigravity's category-first
// flow). Purely presentational; index-based highlighting owned by the Composer,
// reusing the slash-menu CSS. A bare `@` shows the category chooser; after a
// category is chosen the Composer passes that category's item rows + a header.
export function MentionMenu({
  rows,
  header,
  highlightedIndex,
  onHighlight,
  onSelect
}: MentionMenuProps): React.JSX.Element {
  return (
    <div className="menu slash-menu mention-menu">
      {header ? <div className="menu-empty">{header}</div> : null}
      {rows.length === 0 ? <div className="menu-empty">No matches.</div> : null}
      {rows.map((row, i) => {
        const kind = row.type === 'category' ? row.kind : row.suggestion.ref.kind
        const label = row.type === 'category' ? row.label : row.suggestion.label
        const detail = row.type === 'item' ? row.suggestion.detail : undefined
        return (
          <div
            key={`${row.type}:${kind}:${label}:${i}`}
            className={'menu-item' + (i === highlightedIndex ? ' highlighted' : '')}
            onMouseEnter={() => onHighlight(i)}
            onClick={() => onSelect(row)}
          >
            <span className="slash-item-icon">
              <KindIcon kind={kind} />
            </span>
            <div className="slash-item-main">
              <span className="slash-item-name">{label}</span>
              {detail ? <span className="slash-item-desc">{detail}</span> : null}
            </div>
            {row.type === 'category' ? (
              <span className="mention-cat-chev">
                <IconChevronRight size={14} />
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
