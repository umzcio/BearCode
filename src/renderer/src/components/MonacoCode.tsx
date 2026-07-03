// Full-file code view for the review pane's file tabs. Lazily loaded.
import { useEffect, useRef } from 'react'
import { EDITOR_OPTIONS, attachCommenting, decorateCommentedLines, monaco } from './monacoCommon'

interface MonacoCodeProps {
  value: string
  language?: string
  commentedLines?: number[]
  onAddComment?: (line: number, text: string) => void
}

export default function MonacoCode({
  value,
  language = 'plaintext',
  commentedLines,
  onAddComment
}: MonacoCodeProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.ICodeEditor | null>(null)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(host, { ...EDITOR_OPTIONS, model })
    edRef.current = editor

    const commenting = onAddComment ? attachCommenting(editor, onAddComment) : undefined

    return () => {
      commenting?.dispose()
      edRef.current = null
      editor.dispose()
      model.dispose()
    }
    // onAddComment intentionally not a dependency: rebinding tears down Monaco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, language])

  useEffect(() => {
    decorations.current?.clear()
    if (edRef.current && commentedLines?.length) {
      decorations.current = decorateCommentedLines(edRef.current, commentedLines)
    }
  }, [commentedLines])

  return <div ref={hostRef} className="monaco-host" />
}
