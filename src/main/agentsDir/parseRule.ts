import type { Rule, RuleActivation } from './types'
import { parseFrontmatter } from './frontmatter'

const ACTIVATIONS: RuleActivation[] = ['always', 'manual', 'model', 'glob']

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
