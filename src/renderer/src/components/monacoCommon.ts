// Shared Monaco setup: theme, worker env, and the line-comment affordance
// used by both the diff view and the plain code view.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

self.MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

monaco.editor.defineTheme('bearcode-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#181818',
    'editor.foreground': '#a8a8a8',
    'diffEditor.insertedTextBackground': '#3ecf8e17',
    'diffEditor.insertedLineBackground': '#3ecf8e12',
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

// Click a line number (or the glyph margin) to open an inline comment
// composer, Antigravity style. Returns a disposable.
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

  const openComposer = (line: number): void => {
    removeZone()
    const node = document.createElement('div')
    node.className = 'comment-zone'
    const ta = document.createElement('textarea')
    ta.placeholder = 'Leave a comment'
    const actions = document.createElement('div')
    actions.className = 'comment-actions'
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.className = 'comment-btn'
    const add = document.createElement('button')
    add.textContent = 'Add Comment'
    add.className = 'comment-btn primary'
    actions.append(cancel, add)
    node.append(ta, actions)
    cancel.onclick = removeZone
    add.onclick = (): void => {
      const value = ta.value.trim()
      if (value) onAdd(line, value)
      removeZone()
    }
    ta.onkeydown = (e): void => {
      e.stopPropagation()
      if (e.key === 'Escape') removeZone()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add.click()
    }
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone({ afterLineNumber: line, heightInPx: 104, domNode: node })
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

  return {
    dispose: () => {
      removeZone()
      mouse.dispose()
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
