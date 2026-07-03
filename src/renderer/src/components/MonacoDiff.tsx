// Loaded lazily by ReviewPanel so the Monaco chunk only downloads when a diff
// is actually reviewed.
import { useEffect, useRef } from 'react'
import { EDITOR_OPTIONS, attachCommenting, decorateCommentedLines, monaco } from './monacoCommon'

interface MonacoDiffProps {
  original: string
  modified: string
  language?: string
  commentedLines?: number[]
  onAddComment?: (line: number, text: string) => void
}

export default function MonacoDiff({
  original,
  modified,
  language = 'markdown',
  commentedLines,
  onAddComment
}: MonacoDiffProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const modifiedEd = useRef<monaco.editor.ICodeEditor | null>(null)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    const editor = monaco.editor.createDiffEditor(host, {
      ...EDITOR_OPTIONS,
      renderSideBySide: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: false }
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    modifiedEd.current = editor.getModifiedEditor()

    const commenting = onAddComment ? attachCommenting(modifiedEd.current, onAddComment) : undefined

    return () => {
      commenting?.dispose()
      modifiedEd.current = null
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    }
    // onAddComment intentionally not a dependency: rebinding tears down Monaco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, modified, language])

  useEffect(() => {
    decorations.current?.clear()
    if (modifiedEd.current && commentedLines?.length) {
      decorations.current = decorateCommentedLines(modifiedEd.current, commentedLines)
    }
  }, [commentedLines])

  return <div ref={hostRef} className="monaco-host" />
}
