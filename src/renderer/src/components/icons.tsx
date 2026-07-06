// Line icons copied from the prototype's inline SVGs.

interface IconProps {
  size?: number
}

function icon(path: React.ReactNode, strokeWidth = 1.8) {
  return function Icon({ size }: IconProps): React.JSX.Element {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        style={size ? { width: size, height: size } : undefined}
      >
        {path}
      </svg>
    )
  }
}

export const IconPanel = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9.5" y1="4" x2="9.5" y2="20" />
  </>
)
export const IconChevronLeft = icon(<path d="M15 6l-6 6 6 6" />)
export const IconChevronRight = icon(<path d="M9 6l6 6-6 6" />)
export const IconChevronDown = icon(<polyline points="6 9 12 15 18 9" />, 2)
export const IconChevronRightSmall = icon(<polyline points="9 6 15 12 9 18" />, 2)
export const IconPlus = icon(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>
)
export const IconHistory = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 13.5" />
  </>
)
export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 8 12 12 15 14" />
  </>
)
export const IconFolder = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
)
export const IconFolderPlus = icon(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </>
)
export const IconFilter = icon(
  <>
    <line x1="5" y1="8" x2="19" y2="8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="10.5" y1="18" x2="13.5" y2="18" />
  </>
)
export const IconSettings = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </>
)
export const IconMic = icon(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <line x1="12" y1="18" x2="12" y2="21" />
  </>
)
export const IconMonitor = icon(
  <>
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <line x1="8" y1="20" x2="16" y2="20" />
  </>
)
export const IconFile = icon(
  <>
    <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6H8z" />
    <polyline points="14 3 14 9 20 9" />
  </>
)
export const IconImage = icon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </>
)
export const IconAt = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </>
)
export const IconSlash = icon(<line x1="15" y1="5" x2="9" y2="19" />)
export const IconGlobe = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
  </>
)
export const IconCopy = icon(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </>
)
export const IconThumbsUp = icon(
  <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4.2-7.2a2 2 0 0 1 3.7 1.1L14 9h5a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17.5 20H7" />
)
export const IconThumbsDown = icon(
  <g transform="rotate(180 12 12)">
    <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4.2-7.2a2 2 0 0 1 3.7 1.1L14 9h5a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17.5 20H7" />
  </g>
)
export const IconClose = icon(
  <>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </>
)
export const IconArrowUp = icon(
  <>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </>,
  2
)
export function IconStop({ size }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={size ? { width: size, height: size } : undefined}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  )
}
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <line x1="20" y1="20" x2="16.5" y2="16.5" />
  </>
)

export const IconDots = icon(
  <>
    <circle cx="12" cy="5" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="19" r="1" fill="currentColor" />
  </>
)
export const IconLines = icon(
  <>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="14" y2="17" />
  </>
)
export const IconPin = icon(<path d="M12 2l3 6 6 .5-4.5 4 1.5 6-6-3.5-6 3.5 1.5-6L3 8.5 9 8z" />)
export const IconArchive = icon(
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </>
)
export const IconOverview = icon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <line x1="8" y1="9" x2="16" y2="9" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="12" y2="17" />
  </>
)
