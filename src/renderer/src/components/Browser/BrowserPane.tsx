import { useEffect, useRef } from 'react'
import './BrowserPane.css'

// F4: the in-app browser pane. This is a PLACEHOLDER rect only -- the real
// pixels come from a main-side WebContentsView (browserManager) positioned over
// this element's screen bounds. On mount we push our bounds to main and show
// the view; a ResizeObserver + window resize keep the view glued to the rect;
// on unmount we hide the view (it detaches on teardown, not here, so switching
// panes doesn't kill a live session).
export function BrowserPane(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const push = (): void => {
      const r = el.getBoundingClientRect()
      void window.bearcode.browser.setBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    void window.bearcode.browser.show()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
      void window.bearcode.browser.hide()
    }
  }, [])
  return <div className="browser-pane" ref={ref} />
}
