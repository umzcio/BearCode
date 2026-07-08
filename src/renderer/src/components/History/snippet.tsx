// Parse the bm25 snippet sentinels emitted by searchHistory (‹mark› … ‹/mark›)
// into React nodes, turning the marked spans into <mark> elements. Pure + no
// dangerouslySetInnerHTML (the snippet is untrusted message content), so it's
// safe and unit-testable. Kept in its own module so HistoryView can stay a
// component-only file (react-refresh).

const OPEN = '‹mark›'
const CLOSE = '‹/mark›'

export function renderSnippet(snippet: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let rest = snippet
  let key = 0
  while (rest.length > 0) {
    const start = rest.indexOf(OPEN)
    if (start === -1) {
      nodes.push(rest)
      break
    }
    if (start > 0) nodes.push(rest.slice(0, start))
    const afterOpen = rest.slice(start + OPEN.length)
    const end = afterOpen.indexOf(CLOSE)
    if (end === -1) {
      nodes.push(afterOpen)
      break
    }
    nodes.push(<mark key={key++}>{afterOpen.slice(0, end)}</mark>)
    rest = afterOpen.slice(end + CLOSE.length)
  }
  return nodes
}
