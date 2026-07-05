// Loaded lazily by the Auxiliary Pane so the Monaco chunk only downloads when
// a diff is actually reviewed.
import { useEffect, useRef } from 'react'
import { EDITOR_OPTIONS, attachCommenting, decorateCommentedLines, monaco } from './monacoCommon'

interface MonacoDiffProps {
  original: string
  modified: string
  language?: string
  commentedLines?: number[]
  onAddComment?: (line: number, text: string) => void
  // Size the host to the diff content and let the parent scroll instead,
  // for Antigravity-style stacked file sections.
  fitContent?: boolean
}

export default function MonacoDiff({
  original,
  modified,
  language = 'markdown',
  commentedLines,
  onAddComment,
  fitContent = false
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
      renderIndicators: false,
      hideUnchangedRegions: { enabled: false },
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
    editor.setModel({ original: originalModel, modified: modifiedModel })
    const mod = editor.getModifiedEditor()
    modifiedEd.current = mod

    const disposables: monaco.IDisposable[] = []
    if (fitContent) {
      const updateHeight = (): void => {
        const h = mod.getContentHeight()
        host.style.height = `${h + 4}px`
        editor.layout()
      }
      disposables.push(editor.onDidUpdateDiff(updateHeight))
      disposables.push(mod.onDidContentSizeChange(updateHeight))
      updateHeight()
    }
    if (onAddComment) disposables.push(attachCommenting(mod, onAddComment))

    return () => {
      disposables.forEach((d) => d.dispose())
      modifiedEd.current = null
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    }
    // onAddComment intentionally not a dependency: rebinding tears down Monaco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, modified, language, fitContent])

  useEffect(() => {
    decorations.current?.clear()
    if (modifiedEd.current && commentedLines?.length) {
      decorations.current = decorateCommentedLines(modifiedEd.current, commentedLines)
    }
  }, [commentedLines])

  return <div ref={hostRef} className="monaco-host" />
}
