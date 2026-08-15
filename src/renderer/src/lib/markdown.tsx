// Minimal markdown renderer for agent prose and thinking bodies.
// Supports: # to #### headings, paragraphs, ordered and unordered lists,
// fenced code blocks, GFM pipe tables, **bold**, *italic*, `inline code`
// (amber chips). No raw HTML ever touches the DOM.
// `trailing` (the streaming cursor) is appended inside the last block.

import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

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

// Per-render document-order counter for citation chips. Each chip carries
// --ms-i (capped at 6) so .cite-ref's pop-in staggers 80ms per chip when a
// source set arrives (BUI grammar rule 3). Deterministic across re-renders:
// the counter resets per Markdown render and chips are emitted in document
// order, so a given chip always gets the same index (a changed index would
// re-trigger the finished animation via its animation-delay).
type ChipOrder = { n: number }

function chipStagger(chipOrder?: ChipOrder): CSSProperties | undefined {
  if (!chipOrder) return undefined
  return { '--ms-i': Math.min(chipOrder.n++, 6) } as CSSProperties
}

// [n] citation markers against the turn's citations list: [3] becomes a small
// anchor to citations[2] (1-based). Out-of-range or citation-less markers stay
// text -- models also write [1] in non-citation contexts.
function pushCiteMarkers(
  out: ReactNode[],
  text: string,
  citations: CitationRef[] | undefined,
  nextKey: () => number,
  citationNumbers?: Map<number, number>,
  chipOrder?: ChipOrder
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
        style={chipStagger(chipOrder)}
        href={cite.url}
        target="_blank"
        rel="noreferrer"
        title={cite.title ?? cite.url}
      >
        {citationNumbers?.get(idx) ?? idx}
      </a>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
}

// Prose pass: FIRST extract [text](url) markdown links (Grok/GPT write these
// inline -- unsupported until 2026-07-19 they rendered as raw text), THEN run
// the [n] citation-marker pass on the segments between links. A link whose
// visible text is itself a bracketed number ("[[1]](url)") renders as the
// same compact cite-ref chip the metadata-driven markers use.
// Two alternations: [[n]](url) (Grok's citation style -- double brackets) and
// plain [text](url). Groups: 1/2 = cite number + url, 3/4 = label + url.
const LINK_RE = /\[\[(\d{1,2})\]\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
function pushProse(
  out: ReactNode[],
  text: string,
  citations: CitationRef[] | undefined,
  nextKey: () => number,
  citationNumbers?: Map<number, number>,
  chipOrder?: ChipOrder
): void {
  LINK_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last)
      pushCiteMarkers(
        out,
        text.slice(last, m.index),
        citations,
        nextKey,
        citationNumbers,
        chipOrder
      )
    if (m[1]) {
      out.push(
        <a
          key={nextKey()}
          className="cite-ref"
          style={chipStagger(chipOrder)}
          href={m[2]}
          target="_blank"
          rel="noreferrer"
          title={m[2]}
        >
          {m[1]}
        </a>
      )
    } else {
      const label = m[3]
      const url = m[4]
      const citeNum = /^(\d{1,2})$/.exec(label)
      out.push(
        citeNum ? (
          <a
            key={nextKey()}
            className="cite-ref"
            style={chipStagger(chipOrder)}
            href={url}
            target="_blank"
            rel="noreferrer"
            title={url}
          >
            {citeNum[1]}
          </a>
        ) : (
          <a key={nextKey()} className="md-link" href={url} target="_blank" rel="noreferrer">
            {label}
          </a>
        )
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length)
    pushCiteMarkers(out, text.slice(last), citations, nextKey, citationNumbers, chipOrder)
}

function renderInline(
  text: string,
  onFileClick?: (path: string) => void,
  onFileOpen?: (path: string) => void,
  citations?: CitationRef[],
  citationNumbers?: Map<number, number>,
  chipOrder?: ChipOrder
): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  const nextKey = (): number => key++
  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      pushProse(out, text.slice(last, m.index), citations, nextKey, citationNumbers, chipOrder)
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
      pushProse(children, tok.slice(2, -2), citations, nextKey, citationNumbers, chipOrder)
      out.push(<b key={nextKey()}>{children}</b>)
    } else {
      const children: ReactNode[] = []
      pushProse(children, tok.slice(1, -1), citations, nextKey, citationNumbers, chipOrder)
      out.push(<i key={nextKey()}>{children}</i>)
    }
    last = m.index + tok.length
  }
  if (last < text.length)
    pushProse(out, text.slice(last), citations, nextKey, citationNumbers, chipOrder)
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

// Fenced code block, BUI CodeBlock chrome: a card with a header row (language
// label + quiet copy affordance) over the inset code well. Copy goes through
// navigator.clipboard (kept dependency-free like the rest of this lib) and is
// guarded so environments without it (jsdom) never throw.
function CodeBlock({
  lang,
  text,
  tail,
  className
}: {
  lang: string
  text: string
  tail: ReactNode
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const write = navigator.clipboard?.writeText(text)
    if (write)
      void write.then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
  }
  return (
    <div className={className ? `code-card ${className}` : 'code-card'}>
      <div className="code-card-head">
        <span className="code-card-lang">{lang || 'code'}</span>
        <button
          type="button"
          className={'code-copy' + (copied ? ' copied' : '')}
          aria-label="Copy code"
          onClick={copy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code-block">
        <code>{text}</code>
        {tail}
      </pre>
    </div>
  )
}

function List({
  ordered,
  items,
  tail,
  onFileClick,
  onFileOpen,
  citations,
  citationNumbers,
  chipOrder,
  className
}: {
  ordered: boolean
  items: string[]
  tail: ReactNode
  onFileClick?: (path: string) => void
  onFileOpen?: (path: string) => void
  citations?: CitationRef[]
  citationNumbers?: Map<number, number>
  chipOrder?: ChipOrder
  className?: string
}): React.JSX.Element {
  const rows = items.map((item, j) => (
    <li key={j}>
      {renderInline(item, onFileClick, onFileOpen, citations, citationNumbers, chipOrder)}
      {j === items.length - 1 ? tail : null}
    </li>
  ))
  return ordered ? <ol className={className}>{rows}</ol> : <ul className={className}>{rows}</ul>
}

export function Markdown({
  text,
  trailing,
  onFileClick,
  onFileOpen,
  citations,
  citationNumbers
}: {
  text: string
  trailing?: ReactNode
  onFileClick?: (path: string) => void
  onFileOpen?: (path: string) => void
  citations?: CitationRef[]
  citationNumbers?: Map<number, number>
}): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const lastIndex = blocks.length - 1
  // Document-order stagger counter for citation chips, reset every render so
  // a given chip's --ms-i is stable across re-renders (see chipStagger).
  const chipOrder: ChipOrder = { n: 0 }
  return (
    <>
      {blocks.map((block, i) => {
        const tail = trailing && i === lastIndex ? trailing : null
        // BUI streamed-text materialization: while streaming (`trailing` is
        // the cursor), ONLY the block currently receiving text carries
        // .ms-stream-in (events.css). Earlier blocks lose the class when a
        // new block starts, so they never re-animate; settled history
        // (no trailing) renders with no animation at all.
        const enter = trailing && i === lastIndex ? 'ms-stream-in' : undefined
        if (block.kind === 'h5')
          return (
            <h5 key={i} className={enter}>
              {renderInline(
                block.text,
                onFileClick,
                onFileOpen,
                citations,
                citationNumbers,
                chipOrder
              )}
            </h5>
          )
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
              citationNumbers={citationNumbers}
              chipOrder={chipOrder}
              className={enter}
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
              citationNumbers={citationNumbers}
              chipOrder={chipOrder}
              className={enter}
            />
          )
        if (block.kind === 'code')
          return (
            <CodeBlock key={i} lang={block.lang} text={block.text} tail={tail} className={enter} />
          )
        if (block.kind === 'table')
          return (
            <div key={i} className={enter ? `md-table-wrap ${enter}` : 'md-table-wrap'}>
              <table className="md-table">
                <thead>
                  <tr>
                    {block.headers.map((h, k) => (
                      <th key={k}>
                        {renderInline(
                          h,
                          onFileClick,
                          onFileOpen,
                          citations,
                          citationNumbers,
                          chipOrder
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {block.headers.map((_, c) => (
                        <td key={c}>
                          {renderInline(
                            row[c] ?? '',
                            onFileClick,
                            onFileOpen,
                            citations,
                            citationNumbers,
                            chipOrder
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {tail}
            </div>
          )
        return (
          <p key={i} className={enter}>
            {block.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderInline(line, onFileClick, onFileOpen, citations, citationNumbers, chipOrder)}
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
