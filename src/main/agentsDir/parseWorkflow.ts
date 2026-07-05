import { parseFrontmatter } from './frontmatter'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { Workflow } from './types'

// Top-level (column 0) list-item markers (design 3.1, DOCUMENTED CHOICE on
// the exact grammar, Task 1 Step 1): numbered `1.` / `1)`, or dashed `-`/`*`.
// The dash form is a small documented superset of the design's "ordered/
// numbered" wording so real-world dash-list workflows do not collapse to one
// blob step.
const NUMBERED_ITEM = /^\d+[.)]\s+(.*)$/
const DASHED_ITEM = /^[-*]\s+(.*)$/
// An indented, non-blank continuation line: attaches to the current step.
const CONTINUATION_LINE = /^[ \t]+\S/

// Extract a workflow body's steps (design 3.1). Top-level list items become
// steps in order; indented continuation lines attach to the current step;
// text before the first list item (and any other non-list, non-continuation
// line) is ignored for steps -- it stays in `body` untouched. A body with no
// top-level list at all is ONE step: the whole trimmed body.
export function extractSteps(body: string): string[] {
  const lines = body.split('\n')
  const steps: string[] = []
  let current: string[] | null = null

  for (const line of lines) {
    if (line.trim() === '') continue

    const numbered = NUMBERED_ITEM.exec(line)
    const dashed = numbered ? null : DASHED_ITEM.exec(line)
    if (numbered || dashed) {
      if (current) steps.push(current.join('\n'))
      current = [(numbered ?? dashed)![1]]
      continue
    }

    if (current && CONTINUATION_LINE.test(line)) {
      current.push(line.trim())
      continue
    }
    // Any other line (prose before the first item, or an unindented line
    // once inside a list) does not affect step extraction.
  }
  if (current) steps.push(current.join('\n'))

  if (steps.length > 0) return steps

  const trimmed = body.trim()
  return trimmed === '' ? [] : [trimmed]
}

// Parse one workflow file's raw text into a Workflow (design 3.1/5.1, D2
// Task 1). Pure: no disk access, no @-cross-reference resolution (that is
// rules-only, design 3.1 -- a workflow body's `@x` token stays literal).
// Malformed or misnamed input never throws -- it comes back as a Workflow
// with `error` set and `body`/`description` preserved where available, so
// the slash menu can still show a greyed entry (design 5.1/11).
//
// CRLF handling mirrors parseRuleFile: normalized to LF at entry, so both
// the frontmatter reader and step extraction only ever see '\n'.
export function parseWorkflowFile(
  name: string,
  raw: string,
  source: 'project' | 'global'
): Workflow {
  const text = raw.replace(/\r\n/g, '\n')
  const fm = parseFrontmatter(text)

  if (fm?.error) {
    return {
      name,
      description: '',
      body: fm.body,
      steps: [],
      source,
      error: fm.error
    }
  }

  // Workflow files only consume `description`; `activation`/`globs` keys are
  // rule-only and ignored here even if present in the file (design/Task 1).
  const description = fm?.description ?? ''
  const body = fm ? fm.body : text

  if (body.trim() === '') {
    return { name, description, body, steps: [], source, error: 'workflow file is empty' }
  }

  const steps = extractSteps(body)

  if (!COMMAND_NAME_PATTERN.test(name)) {
    return {
      name,
      description,
      body,
      steps,
      source,
      error: 'workflow filename must be kebab-case (lowercase letters, digits, dashes)'
    }
  }

  return { name, description, body, steps, source, error: undefined }
}
