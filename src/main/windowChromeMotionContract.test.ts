import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const chromeCss = readFileSync(
  join(mainDir, '../renderer/src/components/WindowChrome/WindowChromeControls.css'),
  'utf8'
)

function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|})\\s*${escaped}\\s*{([^{}]*)}`, 'm'))
  return match?.[1] ?? ''
}

describe('persistent window chrome motion contract', () => {
  it('locally exempts fixed chrome buttons from transition and active scaling', () => {
    const button = ruleBody(chromeCss, '.window-chrome-controls .chrome-btn')
    const active = ruleBody(chromeCss, '.window-chrome-controls .chrome-btn:active')

    expect(button).toContain('transition: none;')
    expect(active).toContain('transform: none;')
  })
})
