// F3: an editable Monaco editor for the conflict resolver. Reuses the single
// Monaco integration (worker + themes) from monacoCommon — it is NOT a second
// integration, just another consumer like MonacoDiff/MonacoCode. Lazily loaded.
//
// Controlled: `value` is the source of truth. The model is created once; the
// value effect only writes back when the incoming value actually differs from
// the buffer (e.g. an Accept ours/theirs transform), so ordinary typing doesn't
// reset the cursor. Local edits flow out through `onChange`.
import { useEffect, useRef } from 'react'
import { EDITOR_OPTIONS, monaco } from './monacoCommon'

interface MonacoEditableProps {
  value: string
  language?: string
  onChange: (value: string) => void
}

export default function MonacoEditable({
  value,
  language = 'plaintext',
  onChange
}: MonacoEditableProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.ICodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  // Keep the change callback current without recreating the editor. Updated in
  // an effect (not during render) so React's rules-of-refs stay satisfied.
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(host, {
      ...EDITOR_OPTIONS,
      model,
      readOnly: false,
      glyphMargin: false
    })
    edRef.current = editor
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()))

    return () => {
      sub.dispose()
      edRef.current = null
      editor.dispose()
      model.dispose()
    }
    // Create once; `value` is synced imperatively below so keystrokes don't
    // tear down the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = edRef.current
    if (editor && editor.getValue() !== value) editor.setValue(value)
  }, [value])

  return <div ref={hostRef} className="monaco-host" />
}
