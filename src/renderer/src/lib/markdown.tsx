// Minimal markdown renderer for agent prose and thinking bodies.
// Supports: # to #### headings, paragraphs, ordered and unordered lists,
// fenced code blocks, **bold**, *italic*, `inline code` (amber chips).
// No raw HTML ever touches the DOM.
// `trailing` (the streaming cursor) is appended inside the last block.

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
  | { kind: 'p'; text: string }
  | { kind: 'h5'; text: string }
  | { kind: 'ol'; items: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'code'; lang: string; text: string }

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let ol: string[] = []
  let ul: string[] = []
  let code: string[] | null = null
  let codeLang = ''

  const flush = (): void => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') })
      para = []
    }
    if (ol.length) {
      blocks.push({ kind: 'ol', items: ol })
      ol = []
    }
    if (ul.length) {
      blocks.push({ kind: 'ul', items: ul })
      ul = []
    }
  }

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (code !== null) {
      if (t.startsWith('```')) {
        blocks.push({ kind: 'code', lang: codeLang, text: code.join('\n') })
        code = null
      } else {
        code.push(line.replace(/\t/g, '  '))
      }
      continue
    }
    if (t.startsWith('```')) {
      flush()
      code = []
      codeLang = t.slice(3).trim()
    } else if (t === '') {
      flush()
    } else if (/^#{1,4}\s/.test(t)) {
      flush()
      blocks.push({ kind: 'h5', text: t.replace(/^#{1,4}\s/, '') })
    } else if (/^\d+\.\s/.test(t)) {
      para.length && flush()
      ul.length && flush()
      ol.push(t.replace(/^\d+\.\s/, ''))
    } else if (/^[-*]\s/.test(t)) {
      para.length && flush()
      ol.length && flush()
      ul.push(t.replace(/^[-*]\s/, ''))
    } else {
      ol.length && flush()
      ul.length && flush()
      para.push(t)
    }
  }
  // An unterminated fence still renders as code so streaming looks right.
  if (code !== null) blocks.push({ kind: 'code', lang: codeLang, text: code.join('\n') })
  flush()
  return blocks
}

function List({
  ordered,
  items,
  tail
}: {
  ordered: boolean
  items: string[]
  tail: ReactNode
}): React.JSX.Element {
  const rows = items.map((item, j) => (
    <li key={j}>
      {renderInline(item)}
      {j === items.length - 1 ? tail : null}
    </li>
  ))
  return ordered ? <ol>{rows}</ol> : <ul>{rows}</ul>
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
        if (block.kind === 'ol') return <List key={i} ordered items={block.items} tail={tail} />
        if (block.kind === 'ul')
          return <List key={i} ordered={false} items={block.items} tail={tail} />
        if (block.kind === 'code')
          return (
            <pre key={i} className="code-block">
              <code>{block.text}</code>
              {tail}
            </pre>
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
