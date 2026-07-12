// Zoom-corrected rect helpers, centralized here so every popover/menu/hint
// anchors correctly at any font-size zoom level instead of re-deriving this
// math per-component (previously copy-pasted in Select/Hint/ConvoRowMenu).

export interface ZoomRect {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

// The app sets CSS `zoom` on <html> for font size (appearance.ts). A
// position:fixed element is re-scaled by that zoom, while
// getBoundingClientRect() already returns zoom-scaled coordinates -- so a raw
// rect would land a fixed-positioned popover at position*zoom^2. Divide by
// the zoom factor so it sits exactly under its anchor at every font size
// (small/medium/large).
export function zoomedRect(el: Element): ZoomRect {
  const r = el.getBoundingClientRect()
  const zoom = Number(document.documentElement.style.zoom) || 1
  return {
    top: r.top / zoom,
    left: r.left / zoom,
    bottom: r.bottom / zoom,
    right: r.right / zoom,
    width: r.width / zoom,
    height: r.height / zoom
  }
}

// Viewport size in the same zoom-corrected coordinate space as `zoomedRect`.
export function viewportSize(): { w: number; h: number } {
  const zoom = Number(document.documentElement.style.zoom) || 1
  return { w: window.innerWidth / zoom, h: window.innerHeight / zoom }
}
