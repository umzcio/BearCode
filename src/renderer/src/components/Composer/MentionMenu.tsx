import type { MentionSuggestion } from './mentionQuery'
import { IconLines, IconOverview } from '../icons'
import './SlashMenu.css'

interface MentionMenuProps {
  items: MentionSuggestion[]
  highlightedIndex: number
  onHighlight(index: number): void
  onSelect(item: MentionSuggestion): void
}

const CATEGORY_LABEL: Record<MentionSuggestion['ref']['kind'], string> = {
  file: 'Files',
  rule: 'Rules',
  conversation: 'Conversations'
}

// The @ menu (D3 design 7). Modeled on SlashMenu: purely presentational,
// index-based highlighting owned by the Composer, reusing the slash-menu CSS.
// Renders a small category header before the first item of each kind; the
// header rows are NOT part of the (flat) index the Composer navigates.
export function MentionMenu({
  items,
  highlightedIndex,
  onHighlight,
  onSelect
}: MentionMenuProps): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="menu slash-menu">
        <div className="menu-empty">No matches.</div>
      </div>
    )
  }
  return (
    <div className="menu slash-menu">
      {items.map((item, i) => {
        const prevKind = i > 0 ? items[i - 1].ref.kind : null
        const showHeader = item.ref.kind !== prevKind
        return (
          <div key={`${item.ref.kind}:${item.label}:${i}`}>
            {showHeader ? <div className="menu-empty">{CATEGORY_LABEL[item.ref.kind]}</div> : null}
            <div
              className={'menu-item' + (i === highlightedIndex ? ' highlighted' : '')}
              onMouseEnter={() => onHighlight(i)}
              onClick={() => onSelect(item)}
            >
              <span className="slash-item-icon">
                {item.ref.kind === 'file' ? <IconOverview size={14} /> : <IconLines size={14} />}
              </span>
              <div className="slash-item-main">
                <span className="slash-item-name">{item.label}</span>
                {item.detail ? <span className="slash-item-desc">{item.detail}</span> : null}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
