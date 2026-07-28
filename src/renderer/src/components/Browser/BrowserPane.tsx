import { useCallback, useEffect, useRef } from 'react'
import './BrowserPane.css'

// F4: the in-app browser pane. This is a PLACEHOLDER rect only -- the real
// pixels come from a main-side WebContentsView (browserManager) positioned over
// this element's screen bounds. Geometry reporting continues while hidden so
// the main process always retains final bounds, but native pixels are shown
// only after the owning Artifacts Pane shell reports that it is settled.
export function BrowserPane({ visible }: { visible: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pushBounds = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void window.bearcode.browser.setBounds({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    pushBounds()
    const ro = new ResizeObserver(pushBounds)
    ro.observe(el)
    window.addEventListener('resize', pushBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', pushBounds)
      void window.bearcode.browser.hide()
    }
  }, [pushBounds])

  useEffect(() => {
    if (!visible) {
      void window.bearcode.browser.hide()
      return
    }
    pushBounds()
    void window.bearcode.browser.show()
  }, [pushBounds, visible])

  return <div className="browser-pane" ref={ref} />
}
