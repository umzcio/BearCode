import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const sharedCss = readFileSync(join(mainDir, '../renderer/src/styles/shared.css'), 'utf8')
const popoverCss = readFileSync(join(mainDir, '../renderer/src/components/ui/Popover.css'), 'utf8')

describe('reduced-motion sidebar primitive parity', () => {
  it('removes press and popover scale for both OS and in-app reduced-motion signals', () => {
    const sharedPressables = [
      '.pill-btn:active',
      '.chrome-btn:active',
      '.icon-btn:active',
      '.menu-item:active'
    ]

    for (const selector of sharedPressables) {
      expect(sharedCss).toMatch(
        new RegExp(
          `@media \\(prefers-reduced-motion: reduce\\) \\{[\\s\\S]*?${selector}[\\s\\S]*?transform: none;`
        )
      )
      expect(sharedCss).toMatch(
        new RegExp(`:root\\[data-motion='reduced'\\] ${selector}[\\s\\S]*?transform: none;`)
      )
    }

    expect(popoverCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.popover \{\s*transition: opacity var\(--dur-fast\) var\(--ease-out\);[\s\S]*?@starting-style \{\s*\.popover \{\s*transform: none;/
    )
    expect(popoverCss).toMatch(
      /:root\[data-motion='reduced'\] \.popover \{\s*transition: opacity var\(--dur-fast\) var\(--ease-out\) !important;[\s\S]*?@starting-style \{\s*:root\[data-motion='reduced'\] \.popover \{\s*transform: none;/
    )
  })
})
