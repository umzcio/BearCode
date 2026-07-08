type ConvoLike = { id: string; title: string; projectLabel: string; updatedAt: number }
// F9 (folder = project): a searchable folder. `id` is its workspace path.
type FolderLike = { path: string; label: string; updatedAt: number }

export type SearchEntry = {
  // 'project' kept as the folder kind (drives the folder icon in SearchModal).
  kind: 'conversation' | 'project'
  id: string
  title: string
  subtitle: string
  updatedAt: number
}

const MAX = 50

function isSubsequence(query: string, name: string): boolean {
  let i = 0
  for (let j = 0; j < name.length && i < query.length; j++) if (name[j] === query[i]) i++
  return i === query.length
}
function rank(name: string, query: string): number | null {
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  if (isSubsequence(query, name)) return 2
  return null
}

// Combined fuzzy search over conversations (by title) + folders/projects (by
// label). Empty query -> everything by recency (conversations first, then
// folders). Non-empty -> ranked prefix<substring<subsequence across both kinds,
// ties broken by recency. Capped at 50.
export function searchEntries(
  query: string,
  convos: ConvoLike[],
  folders: FolderLike[]
): SearchEntry[] {
  const convoEntries: SearchEntry[] = convos.map((c) => ({
    kind: 'conversation',
    id: c.id,
    title: c.title,
    subtitle: c.projectLabel,
    updatedAt: c.updatedAt
  }))
  const folderEntries: SearchEntry[] = folders.map((f) => ({
    kind: 'project',
    id: f.path,
    title: f.label,
    subtitle: 'Folder',
    updatedAt: f.updatedAt
  }))
  if (query.trim() === '') {
    const convosByAge = [...convoEntries].sort((a, b) => b.updatedAt - a.updatedAt)
    const projByAge = [...folderEntries].sort((a, b) => b.updatedAt - a.updatedAt)
    return [...convosByAge, ...projByAge].slice(0, MAX)
  }
  const q = query.toLowerCase()
  return [...convoEntries, ...folderEntries]
    .map((e) => ({ e, score: rank(e.title.toLowerCase(), q) }))
    .filter((s): s is { e: SearchEntry; score: number } => s.score !== null)
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : b.e.updatedAt - a.e.updatedAt))
    .map((s) => s.e)
    .slice(0, MAX)
}
