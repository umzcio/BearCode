// Renders drafted plan comments (and an optional free-form message) into the
// markdown block a plan_review resolution carries back to the model (design
// 3.6: "comments+message rendered as markdown quotes"). Pure. The text is
// user-authored chat context for the model -- it is never interpreted as
// shell input or file paths anywhere (design section 4).
import type { ArtifactComment } from '../../shared/types'

export function renderPlanFeedback(comments: readonly ArtifactComment[], message?: string): string {
  const parts: string[] = []
  for (const c of comments) {
    const quoted = c.quote
      ? c.quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n') + '\n\n'
      : ''
    parts.push(quoted + c.body)
  }
  const msg = message?.trim()
  if (msg) parts.push(msg)
  return parts.join('\n\n')
}
