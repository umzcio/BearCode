// Full-file code view for the review pane's file tabs. Lazily loaded.
import { useEffect, useRef } from 'react'
import { EDITOR_OPTIONS, attachCommenting, decorateCommentedLines, monaco } from './monacoCommon'

interface MonacoCodeProps {
  value: string
  language?: string
  commentedLines?: number[]
  onAddComment?: (line: number, text: string) => void
  // Size the host to the content for stacked file sections.
  fitContent?: boolean
  // Wash every line green: how created files render in Review.
  washAdded?: boolean
}

export default function MonacoCode({
  value,
  language = 'plaintext',
  commentedLines,
  onAddComment,
  fitContent = false,
  washAdded = false
}: MonacoCodeProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.ICodeEditor | null>(null)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(host, {
      ...EDITOR_OPTIONS,
      model,
      ...(fitContent
        ? {
            scrollbar: {
              vertical: 'hidden' as const,
              handleMouseWheel: false,
              alwaysConsumeMouseWheel: false
            }
          }
        : {})
    })
    edRef.current = editor

    const disposables: monaco.IDisposable[] = []
    if (fitContent) {
      const updateHeight = (): void => {
        host.style.height = `${editor.getContentHeight() + 4}px`
        editor.layout()
      }
      disposables.push(editor.onDidContentSizeChange(updateHeight))
      updateHeight()
    }
    let wash: monaco.editor.IEditorDecorationsCollection | undefined
    if (washAdded) {
      wash = editor.createDecorationsCollection([
        {
          range: new monaco.Range(1, 1, model.getLineCount(), 1),
          options: { isWholeLine: true, className: 'added-wash' }
        }
      ])
    }
    if (onAddComment) disposables.push(attachCommenting(editor, onAddComment))

    return () => {
      wash?.clear()
      disposables.forEach((d) => d.dispose())
      edRef.current = null
      editor.dispose()
      model.dispose()
    }
    // onAddComment intentionally not a dependency: rebinding tears down Monaco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, language, fitContent, washAdded])

  useEffect(() => {
    decorations.current?.clear()
    if (edRef.current && commentedLines?.length) {
      decorations.current = decorateCommentedLines(edRef.current, commentedLines)
    }
  }, [commentedLines])

  return <div ref={hostRef} className="monaco-host" />
}
