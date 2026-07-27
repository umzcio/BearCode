import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const sharedCss = readFileSync(join(mainDir, '../renderer/src/styles/shared.css'), 'utf8')
const popoverCss = readFileSync(join(mainDir, '../renderer/src/components/ui/Popover.css'), 'utf8')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ruleDeclarations(stylesheet: string, selectorList: string): string {
  const match = stylesheet.match(new RegExp(`${escapeRegExp(selectorList)}\\s*\\{([^{}]*)\\}`))
  if (!match) throw new Error(`Expected CSS rule for ${selectorList}`)
  return match[1]
}

function atRuleBlockContaining(stylesheet: string, atRule: string, selectorList: string): string {
  let atRuleStart = stylesheet.indexOf(atRule)
  while (atRuleStart !== -1) {
    const openBrace = stylesheet.indexOf('{', atRuleStart)
    let depth = 1
    let cursor = openBrace + 1

    while (depth > 0 && cursor < stylesheet.length) {
      if (stylesheet[cursor] === '{') depth++
      if (stylesheet[cursor] === '}') depth--
      cursor++
    }

    const block = stylesheet.slice(openBrace + 1, cursor - 1)
    if (new RegExp(escapeRegExp(selectorList)).test(block)) return block
    atRuleStart = stylesheet.indexOf(atRule, cursor)
  }

  throw new Error(`Expected ${atRule} block containing ${selectorList}`)
}

describe('reduced-motion sidebar primitive parity', () => {
  it('removes press and popover scale for both OS and in-app reduced-motion signals', () => {
    const sharedPressables = [
      '.pill-btn:active',
      '.chrome-btn:active',
      '.icon-btn:active',
      '.menu-item:active'
    ]
    const osPressRule = sharedPressables.join(',\n  ')
    const inAppPressRule = sharedPressables
      .map((selector) => `:root[data-motion='reduced'] ${selector}`)
      .join(',\n')

    const osPressDeclarations = ruleDeclarations(
      atRuleBlockContaining(sharedCss, '@media (prefers-reduced-motion: reduce)', osPressRule),
      osPressRule
    )
    const inAppPressDeclarations = ruleDeclarations(sharedCss, inAppPressRule)

    expect(osPressDeclarations).toContain('transform: none;')
    expect(inAppPressDeclarations).toContain('transform: none;')

    const osPopoverDeclarations = ruleDeclarations(
      atRuleBlockContaining(popoverCss, '@media (prefers-reduced-motion: reduce)', '.popover'),
      '.popover'
    )
    const osPopoverStartingDeclarations = ruleDeclarations(
      atRuleBlockContaining(
        atRuleBlockContaining(popoverCss, '@media (prefers-reduced-motion: reduce)', '.popover'),
        '@starting-style',
        '.popover'
      ),
      '.popover'
    )
    const inAppPopoverSelector = ":root[data-motion='reduced'] .popover"
    const inAppPopoverDeclarations = ruleDeclarations(popoverCss, inAppPopoverSelector)
    const inAppPopoverStartingDeclarations = ruleDeclarations(
      atRuleBlockContaining(popoverCss, '@starting-style', inAppPopoverSelector),
      inAppPopoverSelector
    )

    expect(osPopoverDeclarations).toContain('transition: opacity var(--dur-fast) var(--ease-out);')
    expect(osPopoverStartingDeclarations).toContain('transform: none;')
    expect(inAppPopoverDeclarations).toContain(
      'transition: opacity var(--dur-fast) var(--ease-out) !important;'
    )
    expect(inAppPopoverStartingDeclarations).toContain('transform: none;')
  })
})
