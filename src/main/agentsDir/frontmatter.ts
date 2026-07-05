// Line-based frontmatter reader shared by parseRule.ts and parseWorkflow.ts
// (design 3.1: "no regex-heavy YAML emulation"). Lifted out of parseRule.ts
// (D2 Task 1) so both parsers call the exact same implementation instead of
// two copies drifting -- rule tests pin that this move is byte-identical
// behavior. Recognizes `activation:`, `description:`, and `globs:` (inline
// `[...]` or following `- item` lines); every other key is ignored. Rule
// files consume all three keys; workflow files consume only `description`
// and ignore `activation`/`globs` if present (Task 1) -- the reader itself
// stays generic.

export interface ParsedFrontmatter {
  activation?: string
  description?: string
  globs?: string[]
  body: string
  error?: string
}

// Strip a single layer of matching quotes (' or ") from a trimmed value, if
// present. Not full YAML string-escaping -- the frontmatter subset (design
// 3.1) only needs enough to let `"*.ts"` and plain `*.ts` parse the same.
export function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1)
    }
  }
  return t
}

// Split an inline `[a, b, "c"]` list on top-level commas (there is no nesting
// in this grammar, so a plain split is sufficient) and unquote each item.
export function parseInlineList(inner: string): string[] {
  const trimmed = inner.trim()
  if (trimmed === '') return []
  return trimmed
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s !== '')
}

// Returns null if the input doesn't open with a `---` frontmatter block at
// all (frontmatter is optional), or an object with an `error` populated if a
// `---` block was opened but never closed.
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  if (!raw.startsWith('---')) return null
  const firstLineEnd = raw.indexOf('\n')
  const afterOpen = firstLineEnd === -1 ? '' : raw.slice(firstLineEnd + 1)
  // The opening line must be exactly '---' (optionally trailing whitespace).
  const openLine = firstLineEnd === -1 ? raw : raw.slice(0, firstLineEnd)
  if (openLine.trim() !== '---') return null

  // The closer may be the very first line after the opener (an empty
  // frontmatter block, valid: defaults apply) or any later '---' line.
  const closeMatch = afterOpen.match(/(?:^|\n)---[ \t]*(?:\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) {
    return { body: raw, error: 'frontmatter block is missing a closing "---"' }
  }
  const frontmatterText = afterOpen.slice(0, closeMatch.index)
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length)

  const lines = frontmatterText.split('\n')
  let activation: string | undefined
  let description: string | undefined
  let globs: string[] | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const rest = m[2]

    if (key === 'activation') {
      activation = unquote(rest)
    } else if (key === 'description') {
      description = unquote(rest)
    } else if (key === 'globs') {
      const valueOnLine = rest.trim()
      if (valueOnLine.startsWith('[')) {
        const closeBracket = valueOnLine.indexOf(']')
        const inner =
          closeBracket === -1 ? valueOnLine.slice(1) : valueOnLine.slice(1, closeBracket)
        globs = parseInlineList(inner)
      } else {
        // Dash-list form: following lines like `  - item` belong to this key.
        const items: string[] = []
        let j = i + 1
        while (j < lines.length) {
          const dashMatch = lines[j].match(/^\s*-\s*(.*)$/)
          if (!dashMatch) break
          items.push(unquote(dashMatch[1]))
          j++
        }
        globs = items
        i = j - 1
      }
    }
  }

  return { activation, description, globs, body }
}
