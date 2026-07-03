// Minimal markdown renderer for agent prose and thinking bodies.
// Supports: ### subheads, paragraphs, ordered lists, **bold**, *italic*,
// `inline code` (amber chips). No raw HTML ever touches the DOM.
// `trailing` (the streaming cursor) is appended inside the last paragraph.

import type { ReactNode } from 'react'

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(
        <code key={key++} className="tok">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      out.push(<b key={key++}>{tok.slice(2, -2)}</b>)
    } else {
      out.push(<i key={key++}>{tok.slice(1, -1)}</i>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block =
  { kind: 'p'; text: string } | { kind: 'h5'; text: string } | { kind: 'ol'; items: string[] }

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: string[] = []

  const flushPara = (): void => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') })
      para = []
    }
  }
  const flushList = (): void => {
    if (list.length) {
      blocks.push({ kind: 'ol', items: list })
      list = []
    }
  }

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') {
      flushPara()
      flushList()
    } else if (t.startsWith('### ')) {
      flushPara()
      flushList()
      blocks.push({ kind: 'h5', text: t.slice(4) })
    } else if (/^\d+\.\s/.test(t)) {
      flushPara()
      list.push(t.replace(/^\d+\.\s/, ''))
    } else {
      flushList()
      para.push(t)
    }
  }
  flushPara()
  flushList()
  return blocks
}

export function Markdown({
  text,
  trailing
}: {
  text: string
  trailing?: ReactNode
}): React.JSX.Element {
  const blocks = parseBlocks(text)
  const lastIndex = blocks.length - 1
  return (
    <>
      {blocks.map((block, i) => {
        const tail = trailing && i === lastIndex ? trailing : null
        if (block.kind === 'h5') return <h5 key={i}>{renderInline(block.text)}</h5>
        if (block.kind === 'ol')
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>
                  {renderInline(item)}
                  {j === block.items.length - 1 ? tail : null}
                </li>
              ))}
            </ol>
          )
        return (
          <p key={i}>
            {renderInline(block.text)}
            {tail}
          </p>
        )
      })}
      {blocks.length === 0 && trailing ? <p>{trailing}</p> : null}
    </>
  )
}
