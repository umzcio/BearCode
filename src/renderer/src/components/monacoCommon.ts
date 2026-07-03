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
  contextmenu: false
} as const

export { monaco }

const FAB_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>' +
  '<line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>'

// Hover any line for the floating blue Comment button (or click a line
// number) to open an inline comment composer, Antigravity style.
export function attachCommenting(
  ed: monaco.editor.ICodeEditor,
  onAdd: (line: number, text: string) => void
): monaco.IDisposable {
  let zoneId: string | null = null

  const removeZone = (): void => {
    if (!zoneId) return
    const id = zoneId
    zoneId = null
    ed.changeViewZones((acc) => acc.removeZone(id))
  }

  let activeLine: monaco.editor.IEditorDecorationsCollection | null = null

  const clearActiveLine = (): void => {
    activeLine?.clear()
    activeLine = null
  }

  const openComposer = (line: number): void => {
    removeZone()
    clearActiveLine()
    // Highlight the line being commented on while the composer is open.
    activeLine = ed.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'commenting-line' }
      }
    ])

    const node = document.createElement('div')
    node.className = 'comment-zone-wrap'
    const card = document.createElement('div')
    card.className = 'comment-zone'
    const ta = document.createElement('textarea')
    ta.placeholder = 'Leave a comment'
    ta.rows = 1
    const actions = document.createElement('div')
    actions.className = 'comment-actions'
    const mic = document.createElement('button')
    mic.className = 'comment-mic'
    mic.title = 'Voice input: coming soon'
    mic.disabled = true
    mic.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
      '<rect x="9" y="3" width="6" height="11" rx="3"/>' +
      '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/></svg>'
    const spacer = document.createElement('span')
    spacer.className = 'comment-spacer'
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.className = 'comment-cancel'
    const add = document.createElement('button')
    add.textContent = 'Add Comment'
    add.className = 'comment-add'
    add.disabled = true
    actions.append(mic, spacer, cancel, add)
    card.append(ta, actions)
    node.append(card)

    const close = (): void => {
      clearActiveLine()
      removeZone()
    }
    cancel.onclick = close
    add.onclick = (): void => {
      const value = ta.value.trim()
      if (value) onAdd(line, value)
      close()
    }
    ta.oninput = (): void => {
      add.disabled = ta.value.trim().length === 0
    }
    ta.onkeydown = (e): void => {
      e.stopPropagation()
      if (e.key === 'Escape') close()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        add.click()
      }
    }
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone({ afterLineNumber: line, heightInPx: 138, domNode: node })
    })
    window.setTimeout(() => ta.focus(), 60)
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
  const container = ed.getContainerDomNode()
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
  const scroll = ed.onDidScrollChange(hideFab)
  fab.onclick = (): void => {
    hideFab()
    openComposer(fabLine)
  }

  return {
    dispose: () => {
      clearActiveLine()
      removeZone()
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
