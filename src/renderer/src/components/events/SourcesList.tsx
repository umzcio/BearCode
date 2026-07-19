import type { JSX } from 'react'
import type { SourceCitation } from '@shared/types'

// The [n] markers models like Perplexity's sonar family leave in their answer
// text are 1-based indexes into turn_meta.citations -- this list is what they
// point at. Numbering here MUST stay 1-based to match. Links open in the
// system browser (main's setWindowOpenHandler denies + shell.openExternal).
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function SourcesList({ citations }: { citations: SourceCitation[] }): JSX.Element | null {
  if (citations.length === 0) return null
  return (
    <div className="sources-list">
      <div className="sources-title">Sources</div>
      <ol className="sources-items">
        {citations.map((c, i) => (
          <li key={`${i}-${c.url}`}>
            <a
              className="sources-item"
              href={c.url}
              target="_blank"
              rel="noreferrer"
              title={c.url}
            >
              <span className="sources-num">{i + 1}</span>
              <span className="sources-text">{c.title ?? domainOf(c.url)}</span>
              {c.title ? <span className="sources-domain">{domainOf(c.url)}</span> : null}
            </a>
          </li>
        ))}
      </ol>
    </div>
  )
}
