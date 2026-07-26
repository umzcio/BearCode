import { ConvoRowMenu } from './ConvoRowMenu'
import { IconArchive, IconPin } from '../icons'

interface ConvoRowProps {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  /** Omit to render no selected state at all (ProjectPage's usage -- it has
   * no notion of one of its listed conversations being "the current view"
   * the way the cross-project Sidebar list does). */
  selected?: boolean
  /** Omit to render no color dot (ProjectPage's usage). */
  dotColor?: string
  /** Worktree-branch subtitle (Display Options > Subtitle: Worktree),
   * already computed by the caller. Omit to render no subtitle span. */
  subtitle?: string
  /** Relative-age label (ProjectPage's usage). Omit to render no age span. */
  age?: string
  /** 'sb-flatrow' for Sidebar rows, 'pp-row' for ProjectPage rows. */
  rowClassName: string
  /** 'sb-rowact' for Sidebar rows, 'pp-rowact' for ProjectPage rows. */
  actionsClassName: string
  onOpen: () => void
  onTogglePinned: () => void
  onToggleArchived: () => void
}

/**
 * Shared conversation-row rendering for Sidebar.tsx's Pinned/Recents blocks
 * and ProjectPage.tsx's per-bucket rows. See planning/improve-plans/010 for
 * the extraction rationale -- the three call sites differed only in a small,
 * explicit set of optional props (selected state, color dot, subtitle, age,
 * and which row/actions class name to apply), all preserved here rather than
 * silently dropped or forced onto call sites that never had them.
 */
export function ConvoRow({
  id,
  title,
  pinned,
  archived,
  selected,
  dotColor,
  subtitle,
  age,
  rowClassName,
  actionsClassName,
  onOpen,
  onTogglePinned,
  onToggleArchived
}: ConvoRowProps): React.JSX.Element {
  return (
    <div
      className={rowClassName + (selected ? ' selected' : '')}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Ignore keys that originated on a nested action button
        // (Pin/Archive/⋮) -- only the row's own focus target
        // should open the conversation.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      {dotColor !== undefined ? <span className="dot" style={{ background: dotColor }} /> : null}
      <span className="name">{title}</span>
      {subtitle !== undefined ? <span className="sub">{subtitle}</span> : null}
      {age !== undefined ? <span className="age">{age}</span> : null}
      <span className={actionsClassName}>
        <button
          type="button"
          className={'row-act' + (pinned ? ' active' : '')}
          aria-label={pinned ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePinned()
          }}
        >
          <IconPin size={13} />
        </button>
        <button
          type="button"
          className={'row-act' + (archived ? ' active' : '')}
          aria-label={archived ? 'Unarchive' : 'Archive'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleArchived()
          }}
        >
          <IconArchive size={13} />
        </button>
        <ConvoRowMenu convoId={id} title={title} />
      </span>
    </div>
  )
}
