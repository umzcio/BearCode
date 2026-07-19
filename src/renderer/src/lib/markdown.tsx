// Minimal markdown renderer for agent prose and thinking bodies.
// Supports: # to #### headings, paragraphs, ordered and unordered lists,
// fenced code blocks, GFM pipe tables, **bold**, *italic*, `inline code`
// (amber chips). No raw HTML ever touches the DOM.
// `trailing` (the streaming cursor) is appended inside the last block.

import { Fragment, useMemo, type ReactNode } from 'react'

// Inline code that names a workspace file, e.g. `index.html`, `src/app.ts`, or
// an absolute path with spaces. Still requires a trailing .ext so prose isn't matched.
const FILE_RE = /^[\w ./-]+\.[A-Za-z0-9]{1,8}$/

// A web source the enclosing turn cited (turn_meta.citations); [n] markers in
// prose are 1-based indexes into this list. Kept structural (url+title) rather
// than importing shared/types to keep this lib dependency-free.
export interface CitationRef {
  url: string
  title?: string
}

// Turn a plain prose segment into nodes, linkifying [n] citation markers when
// the turn carries a citations list: [3] becomes a small anchor to
// citations[2] (1-based). Out-of-range or citation-less markers stay text --
// models also write [1] in non-citation contexts (checklists, code refs).
function pushProse(
  out: ReactNode[],
  text: string,
  citations: CitationRef[] | undefined,
  nextKey: () => number
): void {
  if (!citations || citations.length === 0) {
    out.push(text)
    return
  }
  const re = /\[(\d{1,2})\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1])
    const cite = idx >= 1 && idx <= citations.length ? citations[idx - 1] : undefined
    if (!cite) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <a
        key={nextKey()}
        className="cite-ref"
        href={cite.url}
        target="_blank"
        rel="noreferrer"
        title={cite.title ?? cite.url}
      >
        {idx}
      </a>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
}

function renderInline(
  text: string,
  onFileClick?: (path: string) => void,
  onFileOpen?: (path: string) => void,
  citations?: CitationRef[]
): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  const nextKey = (): number => key++
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushProse(out, text.slice(last, m.index), citations, nextKey)
    const tok = m[0]
    if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1)
      if (onFileClick && FILE_RE.test(inner)) {
        out.push(
          <code
            key={key++}
            className="tok file"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if ((e.metaKey || e.ctrlKey) && onFileOpen) onFileOpen(inner)
              else onFileClick(inner)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if ((e.metaKey || e.ctrlKey) && onFileOpen) onFileOpen(inner)
                else onFileClick(inner)
              }
            }}
          >
            {inner}
          </code>
        )
      } else {
        out.push(
          <code key={key++} className="tok">
            {inner}
          </code>
        )
      }
    } else if (tok.startsWith('**')) {
      const children: ReactNode[] = []
      pushProse(children, tok.slice(2, -2), citations, nextKey)
      out.push(<b key={nextKey()}>{children}</b>)
    } else {
      const children: ReactNode[] = []
      pushProse(children, tok.slice(1, -1), citations, nextKey)
      out.push(<i key={nextKey()}>{children}</i>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) pushProse(out, text.slice(last), citations, nextKey)
  return out
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h5'; text: string }
  | { kind: 'ol'; items: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }

// Split a GFM table row into trimmed cells, tolerating optional leading/
// trailing pipes: "| a | b |" and "a | b" both -> ["a", "b"].
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

// The `|---|:--:|` separator line under a table header (dashes, optional
// alignment colons) -- its presence is what makes the row above a table.
function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let ol: string[] = []
  let ul: string[] = []
  let code: string[] | null = null
  let codeLang = ''

  const flush = (): void => {
    if (para.length) {
      blocks.push({ kind: 'p', lines: para })
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

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
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
    } else if (t.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      // A GFM table: header row followed by a `|---|` separator, then body
      // rows until the first non-pipe line. Requiring the separator keeps a
      // stray `|` in prose from being mistaken for a table.
      flush()
      const headers = splitTableRow(t)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]))
        j++
      }
      blocks.push({ kind: 'table', headers, rows })
      i = j - 1
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
  tail,
  onFileClick,
  onFileOpen,
  citations
}: {
  ordered: boolean
  items: string[]
  tail: ReactNode
  onFileClick?: (path: string) => void
  onFileOpen?: (path: string) => void
  citations?: CitationRef[]
}): React.JSX.Element {
  const rows = items.map((item, j) => (
    <li key={j}>
      {renderInline(item, onFileClick, onFileOpen, citations)}
      {j === items.length - 1 ? tail : null}
    </li>
  ))
  return ordered ? <ol>{rows}</ol> : <ul>{rows}</ul>
}

export function Markdown({
  text,
  trailing,
  onFileClick,
  onFileOpen,
  citations
}: {
  text: string
  trailing?: ReactNode
  onFileClick?: (path: string) => void
  onFileOpen?: (path: string) => void
  citations?: CitationRef[]
}): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const lastIndex = blocks.length - 1
  return (
    <>
      {blocks.map((block, i) => {
        const tail = trailing && i === lastIndex ? trailing : null
        if (block.kind === 'h5')
          return <h5 key={i}>{renderInline(block.text, onFileClick, onFileOpen, citations)}</h5>
        if (block.kind === 'ol')
          return (
            <List
              key={i}
              ordered
              items={block.items}
              tail={tail}
              onFileClick={onFileClick}
              onFileOpen={onFileOpen}
              citations={citations}
            />
          )
        if (block.kind === 'ul')
          return (
            <List
              key={i}
              ordered={false}
              items={block.items}
              tail={tail}
              onFileClick={onFileClick}
              onFileOpen={onFileOpen}
              citations={citations}
            />
          )
        if (block.kind === 'code')
          return (
            <pre key={i} className="code-block">
              <code>{block.text}</code>
              {tail}
            </pre>
          )
        if (block.kind === 'table')
          return (
            <div key={i} className="md-table-wrap">
              <table className="md-table">
                <thead>
                  <tr>
                    {block.headers.map((h, k) => (
                      <th key={k}>{renderInline(h, onFileClick, onFileOpen, citations)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {block.headers.map((_, c) => (
                        <td key={c}>{renderInline(row[c] ?? '', onFileClick, onFileOpen, citations)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {tail}
            </div>
          )
        return (
          <p key={i}>
            {block.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderInline(line, onFileClick, onFileOpen, citations)}
              </Fragment>
            ))}
            {tail}
          </p>
        )
      })}
      {blocks.length === 0 && trailing ? <p>{trailing}</p> : null}
    </>
  )
}
