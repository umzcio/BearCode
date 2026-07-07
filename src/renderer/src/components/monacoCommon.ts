// Shared Monaco setup: theme, worker env, and the line-comment affordance
// used by both the diff view and the plain code view.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

self.MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

// Monokai-flavored syntax over our dark chrome, with Antigravity's olive
// wash on inserted lines.
monaco.editor.defineTheme('bearcode-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'tag', foreground: 'f92672' },
    { token: 'metatag', foreground: 'f92672' },
    { token: 'metatag.html', foreground: 'f92672' },
    { token: 'metatag.content.html', foreground: 'e6db74' },
    { token: 'attribute.name', foreground: 'e6db74' },
    { token: 'attribute.value', foreground: 'ff6188' },
    { token: 'attribute.value.html', foreground: 'ff6188' },
    { token: 'string', foreground: 'e6db74' },
    { token: 'keyword', foreground: 'f92672' },
    { token: 'number', foreground: 'ae81ff' },
    { token: 'comment', foreground: '75715e' },
    { token: 'delimiter.html', foreground: 'c8c8c8' },
    { token: 'attribute.value.number.css', foreground: 'ae81ff' },
    { token: 'attribute.value.unit.css', foreground: 'ae81ff' }
  ],
  colors: {
    'editor.background': '#181818',
    'editor.foreground': '#dcdcdc',
    'diffEditor.insertedTextBackground': '#00000000',
    'diffEditor.insertedLineBackground': '#31391f66',
    'diffEditor.removedTextBackground': '#f06a6a17',
    'diffEditor.removedLineBackground': '#f06a6a12',
    'editorLineNumber.foreground': '#6f6f6f',
    'editorGutter.background': '#181818',
    'scrollbarSlider.background': '#33333388',
    'scrollbarSlider.hoverBackground': '#3d3d3d99'
  }
})

export const EDITOR_OPTIONS = {
  theme: 'bearcode-dark',
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
  lineHeight: 22,
  glyphMargin: true,
  contextmenu: false,
  // Antigravity wraps long lines; it also keeps view-zone widgets (the
  // comment composer) from outgrowing the visible pane.
  wordWrap: 'on' as const,
  overviewRulerLanes: 0
} as const

export { monaco }

const FAB_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>' +
  '<line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>'

const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>'

const X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'

// Hover any line for the floating blue Comment button (or click a line
// number) to open an inline comment composer, Antigravity style. The composer
// lives INSIDE a Monaco view zone, so it displaces the lines below rather than
// floating over them -- the code stays readable around it (design 2026-07-06).
export function attachCommenting(
  ed: monaco.editor.ICodeEditor,
  onAdd: (line: number, text: string) => void
): monaco.IDisposable {
  const container = ed.getContainerDomNode()

  let zoneId: string | null = null
  let zone: monaco.editor.IViewZone | null = null
  let overlay: HTMLElement | null = null
  let overlayLine = 0
  let activeLine: monaco.editor.IEditorDecorationsCollection | null = null

  // Pin the overlay to the top of the reserved gap (just under the commented
  // line), tracking scroll.
  const positionOverlay = (): void => {
    if (!overlay) return
    overlay.style.top = `${ed.getBottomForLineNumber(overlayLine) - ed.getScrollTop()}px`
  }

  const closeComposer = (): void => {
    activeLine?.clear()
    activeLine = null
    overlay?.remove()
    overlay = null
    if (zoneId) {
      const id = zoneId
      zoneId = null
      zone = null
      ed.changeViewZones((acc) => acc.removeZone(id))
    }
  }

  const openComposer = (line: number): void => {
    closeComposer()
    overlayLine = line
    // Highlight the line being commented on while the composer is open.
    activeLine = ed.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'commenting-line' }
      }
    ])

    // A single compact input bar (plus + input + send arrow + cancel,
    // Claude-style). Rendered as an OVERLAY on top of the editor: view-zone
    // content sits BEHIND Monaco's text/cursor layers and goes dead the moment
    // the editor takes focus, so an empty spacer zone reserves the room and
    // this overlay -- always on top -- stays interactive. It's styled flat and
    // sits exactly in the reserved gap, so it still reads as inline.
    overlay = document.createElement('div')
    overlay.className = 'comment-zone-inline'
    const bar = document.createElement('div')
    bar.className = 'comment-bar'
    const ta = document.createElement('textarea')
    ta.className = 'comment-bar-input'
    ta.placeholder = 'Tell the agent what to change'
    ta.rows = 1
    const send = document.createElement('button')
    send.className = 'comment-bar-send'
    send.title = 'Add comment'
    send.innerHTML = ARROW_SVG
    send.disabled = true
    const close = document.createElement('button')
    close.className = 'comment-bar-close'
    close.title = 'Cancel (Esc)'
    close.innerHTML = X_SVG
    bar.append(ta, send, close)
    overlay.appendChild(bar)
    container.appendChild(overlay)

    // Empty spacer view zone reserves the vertical room so code shifts down.
    const spacer = document.createElement('div')
    zone = { afterLineNumber: line, heightInPx: 56, domNode: spacer }
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone(zone as monaco.editor.IViewZone)
    })

    // Grow the input as it wraps and keep the reserved gap matched to the bar.
    const relayout = (): void => {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
      if (zoneId && zone) {
        zone.heightInPx = bar.offsetHeight + 12
        ed.changeViewZones((acc) => acc.layoutZone(zoneId as string))
      }
      positionOverlay()
    }

    const submit = (): void => {
      const value = ta.value.trim()
      if (value) onAdd(line, value)
      closeComposer()
    }
    send.onclick = submit
    close.onclick = closeComposer
    ta.oninput = (): void => {
      send.disabled = ta.value.trim().length === 0
      send.classList.toggle('ready', ta.value.trim().length > 0)
      relayout()
    }
    ta.onkeydown = (e): void => {
      e.stopPropagation()
      if (e.key === 'Escape') closeComposer()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!send.disabled) submit()
      }
    }

    positionOverlay()
    window.setTimeout(() => {
      ta.focus()
      relayout()
    }, 30)
  }

  const mouse = ed.onMouseDown((e) => {
    const t = e.target
    if (
      (t.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) &&
      t.position
    ) {
      openComposer(t.position.lineNumber)
    }
  })

  // Floating Comment button pinned to the right edge of the hovered line.
  const fab = document.createElement('button')
  fab.className = 'comment-fab'
  fab.innerHTML = FAB_SVG
  fab.style.display = 'none'
  container.appendChild(fab)
  let fabLine = 0

  const hideFab = (): void => {
    fab.style.display = 'none'
  }
  const move = ed.onMouseMove((e) => {
    const pos = e.target.position
    if (!pos) return
    fabLine = pos.lineNumber
    fab.style.top = `${ed.getTopForLineNumber(fabLine) - ed.getScrollTop()}px`
    fab.style.display = 'flex'
  })
  const leave = (ev: MouseEvent): void => {
    if (!container.contains(ev.relatedTarget as Node)) hideFab()
  }
  container.addEventListener('mouseleave', leave)
  const scroll = ed.onDidScrollChange(() => {
    hideFab()
    positionOverlay()
  })
  fab.onclick = (): void => {
    hideFab()
    openComposer(fabLine)
  }

  return {
    dispose: () => {
      closeComposer()
      mouse.dispose()
      move.dispose()
      scroll.dispose()
      container.removeEventListener('mouseleave', leave)
      fab.remove()
    }
  }
}

export function decorateCommentedLines(
  ed: monaco.editor.ICodeEditor,
  lines: number[]
): monaco.editor.IEditorDecorationsCollection {
  return ed.createDecorationsCollection(
    lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'commented-line',
        glyphMarginClassName: 'comment-glyph'
      }
    }))
  )
}
