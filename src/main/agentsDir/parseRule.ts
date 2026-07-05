import type { Rule, RuleActivation } from './types'

const ACTIVATIONS: RuleActivation[] = ['always', 'manual', 'model', 'glob']

// Strip a single layer of matching quotes (' or ") from a trimmed value, if
// present. Not full YAML string-escaping -- the frontmatter subset (design
// 3.1) only needs enough to let `"*.ts"` and plain `*.ts` parse the same.
function unquote(v: string): string {
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
function parseInlineList(inner: string): string[] {
  const trimmed = inner.trim()
  if (trimmed === '') return []
  return trimmed
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s !== '')
}

// Line-based frontmatter reader (design 3.1: "no regex-heavy YAML emulation").
// Recognizes `activation:`, `description:`, and `globs:` (inline `[...]` or
// following `- item` lines); every other key is ignored. Returns null if the
// input doesn't open with a `---` frontmatter block at all (frontmatter is
// optional), or an object with an `error` populated if a `---` block was
// opened but never closed.
function parseFrontmatter(raw: string): {
  activation?: string
  description?: string
  globs?: string[]
  body: string
  error?: string
} | null {
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

// Parse one rule file's raw text into a Rule (design 3.1/3.2). Pure: no disk
// access, no cross-reference resolution (that is loadRules' job, Task 2).
// Malformed input never throws -- it comes back as a Rule with `error` set
// and the body preserved, so assembly can skip it while menus can still show
// something (design 11).
//
// CRLF handling: Windows-edited files are normalized to LF at entry, so the
// frontmatter reader only ever sees '\n' line endings and body output is
// always LF-normalized (documented behavior; rules are prompt text, so exact
// on-disk line endings do not need to round-trip).
export function parseRuleFile(name: string, raw: string, source: 'project' | 'global'): Rule {
  const text = raw.replace(/\r\n/g, '\n')
  const fm = parseFrontmatter(text)

  if (fm === null) {
    return {
      name,
      body: text,
      activation: 'always',
      globs: [],
      description: '',
      source,
      error: undefined
    }
  }

  if (fm.error) {
    return {
      name,
      body: fm.body,
      activation: 'always',
      globs: [],
      description: '',
      source,
      error: fm.error
    }
  }

  const activationRaw = fm.activation ?? 'always'
  const globs = fm.globs ?? []
  const description = fm.description ?? ''

  if (!ACTIVATIONS.includes(activationRaw as RuleActivation)) {
    return {
      name,
      body: fm.body,
      activation: 'always',
      globs,
      description,
      source,
      error: `invalid activation "${activationRaw}" (expected one of ${ACTIVATIONS.join(', ')})`
    }
  }
  const activation = activationRaw as RuleActivation

  if (activation === 'model' && description.trim() === '') {
    return {
      name,
      body: fm.body,
      activation,
      globs,
      description,
      source,
      error: 'activation: model requires a description'
    }
  }

  if (activation === 'glob' && globs.length === 0) {
    return {
      name,
      body: fm.body,
      activation,
      globs,
      description,
      source,
      error: 'activation: glob requires at least one entry under globs'
    }
  }

  return { name, body: fm.body, activation, globs, description, source, error: undefined }
}
