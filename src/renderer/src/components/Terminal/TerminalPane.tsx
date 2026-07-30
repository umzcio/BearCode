import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '../../state/store'
import { TERMINAL_FONT } from './termGeometry'
// REQUIRED, not cosmetic. xterm ships internal helper elements -- a character
// measurement probe (whose text content is literally '%' x32) and an offscreen
// input textarea -- and relies on THIS stylesheet to hide and position them.
// Without it they render as visible page content in normal flow, which is
// exactly the "%%%%%%%" line and the stray box that appeared above every
// prompt. It also supplies the viewport/rows positioning xterm assumes.
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

function xtermTheme(): {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
} {
  const styles = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg-window', '#1b1b1b'),
    foreground: v('--text', '#e7e7e7'),
    cursor: v('--accent', '#4c8dff'),
    selectionBackground: v('--bg-active', '#2e2e2e')
  }
}

// One real xterm.js instance per tab. Mounted for the LIFETIME of the tab
// (see TerminalView -- all open tabs stay mounted, stacked via CSS, never
// conditionally unmounted on tab switch), so switching tabs never loses
// scrollback. Output never touches Zustand: onTerminalData writes straight
// into this instance's buffer, which is exactly the perf reason to use a
// real terminal library instead of storing text in app state.
export function TerminalPane({
  id,
  path,
  active
}: {
  id: string
  path: string
  active: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const markExited = useAppStore((s) => s.markTerminalTabExited)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // TERMINAL_FONT is shared with termGeometry's pre-spawn probe -- the two
    // must construct identically or the measured geometry won't match what
    // this pane actually renders.
    const term = new Terminal({ theme: xtermTheme(), ...TERMINAL_FONT })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    void window.bearcode.terminal.resize(id, term.cols, term.rows)

    const disposeOnData = term.onData((data) => {
      void window.bearcode.terminal.write(id, data)
    })
    const unsubscribeData = window.bearcode.onTerminalData((dataId, chunk) => {
      if (dataId === id) term.write(chunk)
    })
    const unsubscribeExit = window.bearcode.onTerminalExit((exitId) => {
      if (exitId === id) markExited(path, id)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      void window.bearcode.terminal.resize(id, term.cols, term.rows)
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      disposeOnData.dispose()
      unsubscribeData()
      unsubscribeExit()
      term.dispose()
    }
    // Mount once per tab id -- this effect intentionally never re-runs for
    // path/markExited changes (a tab's id is stable for its lifetime).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <div className={'terminal-pane' + (active ? ' active' : '')}>
      <div className="terminal-pane-surface" ref={containerRef} />
    </div>
  )
}
