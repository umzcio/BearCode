import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const paneCss = readFileSync(join(mainDir, '../renderer/src/components/ArtifactsPane.css'), 'utf8')

const pressableFamilies = [
  '.ap-actions button',
  '.ap-segmented button',
  '.ap-rail-item',
  '.ap-tab',
  '.version-chip',
  '.overview-file',
  '.plan-review-actions button',
  '.comment-composer-actions button',
  '.comment-bar-send',
  '.comment-bar-close',
  '.comment-del',
  '.foot-btn'
]

describe('Artifacts Pane motion CSS contract', () => {
  it('gives every pane pressable shared color and physical feedback', () => {
    for (const selector of pressableFamilies) {
      expect(paneCss).toContain(selector)
    }
    expect(paneCss).toContain('background-color var(--dur-fast) ease')
    expect(paneCss).toContain('color var(--dur-fast) ease')
    expect(paneCss).toContain('border-color var(--dur-fast) ease')
    expect(paneCss).toContain('transform var(--dur-press-release) var(--ease-out)')
    expect(paneCss).toContain('transform var(--dur-press) var(--ease-out)')
    expect(paneCss).toContain('transform: scale(0.97)')
    expect(paneCss).toMatch(/:disabled[\s\S]*?transform:\s*none/)
  })

  it('removes panel and press transforms for both reduced-motion signals', () => {
    expect(paneCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ap-panel\[data-state='closing'\][\s\S]*?transform:\s*none/
    )
    expect(paneCss).toMatch(/:root\[data-motion='reduced'\] \.ap-panel[\s\S]*?transform:\s*none/)
    expect(paneCss).toMatch(
      /:root\[data-motion='reduced'\][\s\S]*?:active:not\(:disabled\)[\s\S]*?transform:\s*none/
    )
  })
})
