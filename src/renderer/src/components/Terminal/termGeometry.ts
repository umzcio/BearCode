import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSize } from '@shared/types'

// Terminal font settings live here (not inline in TerminalPane) because the
// pre-spawn measurement below MUST construct its probe with byte-identical
// options: cols/rows are derived from the character cell size, so a different
// font or size would measure a different geometry than the pane it is
// standing in for -- which is precisely the mismatch this whole module exists
// to prevent.
export const TERMINAL_FONT = {
  fontFamily: 'Menlo, monospace',
  fontSize: 12
} as const

// Matches .terminal-pane-surface's `padding: 8px` + `box-sizing: border-box`.
const SURFACE_PADDING_PX = 8

// Measure the pty geometry a terminal would have if it were opened inside
// `host`, WITHOUT creating a session first.
//
// Why this exists: the shell prints its first prompt the instant it spawns.
// Sizing the pty afterwards (via a resize) is already too late -- zsh has
// drawn a prompt padded to the wrong width and its cursor model no longer
// matches the display. So the renderer measures first and passes the real
// geometry into create().
//
// The probe is a throwaway xterm rendered offscreen at the host's box size.
// It is opened (not just constructed) because xterm only computes its
// character cell metrics once attached to a laid-out element.
export function measureTerminalSize(host: HTMLElement): TerminalSize | undefined {
  const rect = host.getBoundingClientRect()
  const width = rect.width - SURFACE_PADDING_PX * 2
  const height = rect.height - SURFACE_PADDING_PX * 2
  // Not laid out yet (hidden view, zero-size parent). Returning undefined lets
  // the caller fall back to the main-process default rather than spawning at a
  // geometry derived from a zero box.
  if (width <= 0 || height <= 0) return undefined

  const probeHost = document.createElement('div')
  probeHost.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}px;height:${height}px`
  document.body.appendChild(probeHost)
  const probe = new Terminal({ ...TERMINAL_FONT })
  const fit = new FitAddon()
  probe.loadAddon(fit)
  try {
    probe.open(probeHost)
    fit.fit()
    const { cols, rows } = probe
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return undefined
    return { cols, rows }
  } catch {
    // Measurement is an optimization, never a hard dependency -- a failure
    // here must not block opening a terminal.
    return undefined
  } finally {
    probe.dispose()
    probeHost.remove()
  }
}
