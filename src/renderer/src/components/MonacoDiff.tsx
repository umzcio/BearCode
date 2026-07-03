// Loaded lazily by ReviewModal so the Monaco chunk only downloads when a diff
// is actually reviewed.
import { useEffect, useRef } from 'react'
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
    'editor.background': '#1c1c1c',
    'editor.foreground': '#a8a8a8',
    'diffEditor.insertedTextBackground': '#3ecf8e17',
    'diffEditor.insertedLineBackground': '#3ecf8e12',
    'diffEditor.removedTextBackground': '#f06a6a17',
    'diffEditor.removedLineBackground': '#f06a6a12',
    'editorLineNumber.foreground': '#6f6f6f',
    'editorGutter.background': '#1c1c1c',
    'scrollbarSlider.background': '#33333388',
    'scrollbarSlider.hoverBackground': '#3d3d3d99'
  }
})

interface MonacoDiffProps {
  original: string
  modified: string
  language?: string
}

export default function MonacoDiff({
  original,
  modified,
  language = 'markdown'
}: MonacoDiffProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    const editor = monaco.editor.createDiffEditor(host, {
      theme: 'bearcode-dark',
      readOnly: true,
      renderSideBySide: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
      lineHeight: 22,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: false }
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })

    return () => {
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [original, modified, language])

  return <div ref={hostRef} className="monaco-host" />
}
