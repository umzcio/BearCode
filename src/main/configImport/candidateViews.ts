// Turns the cheap existence-only scan (scan.ts) into the parse-aware list the
// review modal actually needs (final whole-branch review, Finding 6).
//
// Before this, the scan IPC handler returned raw DetectedSources, so the modal
// listed every detected path pre-checked and importable -- including ones that
// CANNOT translate (an empty CLAUDE.md, a non-kebab-case `.claude/commands`
// filename, a SKILL.md missing its required `description`). Those silently
// imported as 0 items with no explanation. The translators' own `warnings`
// (truncation notices, unresolved `@ref` warnings -- routine, since `@` is
// common in prose: `@anthropic-ai/sdk`, email addresses) were likewise computed
// and then dropped on the floor by every consumer.
//
// This module is READ-ONLY: it builds candidates purely to describe them, and
// deliberately does NOT record pendingOutside paths. Scanning happens on every
// folder open for a folder the user may never import from, and recording a
// pending out-of-folder ref is a WRITE that puts a consent prompt in
// OutsideAccessCard. Pending refs are recorded at the two moments where the
// inlining is actually committed to disk: applyImportSelection (importer.ts)
// and applySourceUpdate/checkSourceForUpdate (checkUpdates.ts).
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import { buildSkillCandidate } from './translateSkills'
import type { OutsidePolicy } from '../agentsDir'
import type { DetectedSource, ImportCandidate } from './types'

const PREVIEW_CHARS = 150

// Full-parse describe work (buildRuleCandidate/buildWorkflowCandidate/
// buildSkillCandidate, each of which can itself inline up to MAX_INCLUSIONS
// referenced files at up to MAX_REF_BYTES each -- see agentsDir/index.ts) runs
// on EVERY detected source, on EVERY folder open (setWorkspace ->
// refreshImportBannerState), before the user has trusted the folder or even
// opened the review modal (final whole-branch review, perf finding). Nothing
// here caps the NUMBER of sources scan.ts can find, so a repo with a large
// `.cursor/rules/` tree or a `.claude/skills/` directory with thousands of
// entries could turn a folder open into a synchronous main-process stall.
// Cap how many sources get fully described per call; real CLAUDE.md/AGENTS.md/
// .cursorrules/.windsurfrules/.claude setups are single-digit to low-double-
// digit file counts, so 200 is generous headroom while still bounding worst
// case to ~200 * (up to 65 file reads each) instead of unbounded.
const MAX_PREVIEWED = 200

// Short single-line excerpt of the translated text. Collapses all whitespace
// (rule bodies are multi-line markdown; the modal renders one line) and drops a
// leading frontmatter block, which would otherwise fill the whole preview with
// `--- description: ... ---` instead of the actual instructions.
export function previewOf(text: string): string {
  const withoutFrontmatter = text.startsWith('---')
    ? text.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '')
    : text
  const flat = withoutFrontmatter.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_CHARS) return flat
  return flat.slice(0, PREVIEW_CHARS).trimEnd() + '…'
}

// `outside` is the project's outside-of-folder policy (Finding 1) -- threaded
// so a preview shows exactly what an import WOULD write, gate included.
export function buildCandidateViews(
  projectPath: string,
  detected: DetectedSource[],
  outside?: OutsidePolicy
): ImportCandidate[] {
  // Only kinds that actually trigger a parse (rule/workflow/skill) spend the
  // budget -- 'unsupported' sources already skip straight to a cheap
  // no-preview return inside describeOne, so counting them here would waste
  // budget on sources that were never going to be described anyway.
  let previewed = 0
  return detected.map((d) => {
    if (d.kind !== 'unsupported' && previewed >= MAX_PREVIEWED) {
      return { ...d, buildable: false, notPreviewed: true }
    }
    if (d.kind !== 'unsupported') previewed++
    return describeOne(projectPath, d, outside)
  })
}

function describeOne(
  projectPath: string,
  d: DetectedSource,
  outside?: OutsidePolicy
): ImportCandidate {
  // 'unsupported' is not "failed to parse" -- it is a recognized-but-not-yet-
  // translatable kind (e.g. `.claude/agents/*.md`). It gets its own label in
  // the modal, so no preview/warnings are computed for it.
  if (d.kind === 'unsupported') return { ...d, buildable: false }

  if (d.kind === 'rule') {
    const c = buildRuleCandidate(projectPath, d, outside)
    return c ? view(d, previewOf(c.body), c.warnings) : { ...d, buildable: false }
  }
  if (d.kind === 'workflow') {
    const c = buildWorkflowCandidate(projectPath, d)
    return c ? view(d, previewOf(c.body), c.warnings) : { ...d, buildable: false }
  }
  const c = buildSkillCandidate(projectPath, d)
  return c ? view(d, previewOf(c.description), []) : { ...d, buildable: false }
}

function view(d: DetectedSource, preview: string, warnings: string[]): ImportCandidate {
  return {
    ...d,
    buildable: true,
    ...(preview === '' ? {} : { preview }),
    ...(warnings.length === 0 ? {} : { warnings })
  }
}
