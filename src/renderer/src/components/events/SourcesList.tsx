import { useState, type JSX } from 'react'
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
  // BUI StreamingText sources panel: the title is a disclosure that collapses
  // the panel via the grid-rows trick (.ms-sources-reveal, events.css). Open
  // by default so the list stays visible exactly as before -- the collapse is
  // opt-in, and the panel's arrival still animates via @starting-style.
  const [open, setOpen] = useState(true)
  if (citations.length === 0) return null
  return (
    <div className="sources-list">
      <button
        type="button"
        className="sources-title ms-sources-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className={open ? 'ms-sources-chevron is-open' : 'ms-sources-chevron'}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        Sources
      </button>
      <div className={open ? 'ms-sources-reveal is-open' : 'ms-sources-reveal'}>
        <div className="ms-sources-inner">
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
      </div>
    </div>
  )
}
