import { parseFrontmatter } from './frontmatter'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { Skill } from './types'

// Parse one skill's SKILL.md raw text into a Skill (design 4.1). Pure: no disk
// access, no cross-reference resolution (skill bodies stay literal). Malformed
// input never throws -- it returns a Skill with `error` set and body preserved,
// so the settings page can grey it while the model never sees it (design 4.6).
export function parseSkillFolder(
  name: string,
  skillMdRaw: string,
  source: 'project' | 'global'
): Skill {
  const text = skillMdRaw.replace(/\r\n/g, '\n')
  const fm = parseFrontmatter(text)

  if (fm?.error) {
    return { name, description: '', body: fm.body, source, error: fm.error }
  }

  const body = fm ? fm.body : text
  // name: frontmatter `name` wins; else the folder name (design 4.1). The
  // shared frontmatter reader only surfaces activation/description/globs, so
  // `name:` is read locally here, sliced from just the frontmatter block (never
  // from the body) so a `name:` line in the body can't be mistaken for it.
  const nameMatch = fm ? /(?:^|\n)name:[ \t]*(.*)$/m.exec(textFrontmatter(text)) : null
  const fmName = nameMatch ? stripQuotes(nameMatch[1].trim()) : ''
  const effectiveName = fmName !== '' ? fmName : name
  const description = fm?.description ?? ''

  if (description.trim() === '') {
    return {
      name: effectiveName,
      description: '',
      body,
      source,
      error: 'SKILL.md requires a non-empty description'
    }
  }

  if (!COMMAND_NAME_PATTERN.test(effectiveName)) {
    return {
      name: effectiveName,
      description,
      body,
      source,
      error: 'skill name must be kebab-case (lowercase letters, digits, dashes)'
    }
  }

  return { name: effectiveName, description, body, source, error: undefined }
}

// Slice out just the frontmatter block text (between the opening and closing
// `---`) so a `name:` inside the block is read, never a `name:` in the body.
function textFrontmatter(text: string): string {
  if (!text.startsWith('---')) return ''
  const rest = text.slice(text.indexOf('\n') + 1)
  const close = rest.match(/(?:^|\n)---[ \t]*(?:\n|$)/)
  return close && close.index !== undefined ? rest.slice(0, close.index) : ''
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1)
  }
  return v
}
