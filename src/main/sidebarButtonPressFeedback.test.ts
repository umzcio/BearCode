import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))

type CssRule = {
  selectors: string[]
  declarations: string
  atRules: string[]
}

const osReducedMotion = '@media (prefers-reduced-motion: reduce)'

function cssRules(stylesheet: string, atRules: string[] = []): CssRule[] {
  const rules: CssRule[] = []
  let ruleStart = 0

  while (ruleStart < stylesheet.length) {
    const openBrace = stylesheet.indexOf('{', ruleStart)
    if (openBrace === -1) break

    let depth = 1
    let cursor = openBrace + 1
    while (depth > 0 && cursor < stylesheet.length) {
      if (stylesheet[cursor] === '{') depth++
      if (stylesheet[cursor] === '}') depth--
      cursor++
    }

    const selectorList = stylesheet
      .slice(ruleStart, openBrace)
      .slice(stylesheet.slice(ruleStart, openBrace).lastIndexOf('*/') + 2)
      .trim()
    const declarations = stylesheet.slice(openBrace + 1, cursor - 1)
    if (selectorList.startsWith('@')) {
      rules.push(...cssRules(declarations, [...atRules, selectorList]))
    } else {
      rules.push({
        selectors: selectorList.split(',').map((selector) => selector.trim()),
        declarations,
        atRules
      })
    }

    ruleStart = cursor
  }

  return rules
}

function targetRules(stylesheet: string, selector: string): CssRule[] {
  return cssRules(stylesheet).filter((rule) => rule.selectors.includes(selector))
}

function rootRuleDeclaration(stylesheet: string, selector: string): string {
  const rules = targetRules(stylesheet, selector)
  const rootRules = rules.filter((rule) => rule.atRules.length === 0)
  const conditionalRules = rules.filter((rule) => rule.atRules.length > 0)
  if (rootRules.length !== 1 || conditionalRules.length !== 0) {
    throw new Error(
      `Expected one root CSS rule and no conditional rules for ${selector}, found ${rootRules.length} root and ${conditionalRules.length} conditional`
    )
  }
  return rootRules[0].declarations
}

function activeRuleDeclarations(
  stylesheet: string,
  selector: string
): {
  normal: string
  osReducedMotion: string
} {
  const rules = targetRules(stylesheet, selector)
  const normalRules = rules.filter((rule) => rule.atRules.length === 0)
  const osReducedMotionRules = rules.filter((rule) => rule.atRules.includes(osReducedMotion))
  const unauthorizedRules = rules.filter(
    (rule) => rule.atRules.length > 0 && !rule.atRules.includes(osReducedMotion)
  )
  if (
    normalRules.length !== 1 ||
    osReducedMotionRules.length !== 1 ||
    unauthorizedRules.length !== 0
  ) {
    throw new Error(
      `Expected one normal and one OS reduced-motion CSS rule for ${selector}, found ${normalRules.length} normal, ${osReducedMotionRules.length} OS reduced-motion, and ${unauthorizedRules.length} unauthorized conditional`
    )
  }
  return {
    normal: normalRules[0].declarations,
    osReducedMotion: osReducedMotionRules[0].declarations
  }
}

function ruleSelectorsWithDeclaration(stylesheet: string, declaration: string): string[] {
  return cssRules(stylesheet)
    .filter((rule) => rule.declarations.includes(declaration))
    .flatMap((rule) => rule.selectors)
}

const pressableStylesheets = [
  {
    css: readFileSync(join(mainDir, '../renderer/src/components/Sidebar/Sidebar.css'), 'utf8'),
    selector: '.seg-toggle button'
  },
  {
    css: readFileSync(
      join(mainDir, '../renderer/src/components/Sidebar/SidebarFooterMenu.css'),
      'utf8'
    ),
    selector: '.sb-name-btn'
  },
  {
    css: readFileSync(
      join(mainDir, '../renderer/src/components/ProjectPage/ProjectPage.css'),
      'utf8'
    ),
    selector: '.row-act'
  }
]

describe('sidebar button press feedback', () => {
  it('gives only genuine sidebar buttons the shared press transform', () => {
    for (const { css, selector } of pressableStylesheets) {
      const transition = rootRuleDeclaration(css, selector)
      const active = activeRuleDeclarations(css, `${selector}:active`)

      expect(transition).toContain('background var(--dur-fast) var(--ease-out)')
      expect(transition).toContain('color var(--dur-fast) var(--ease-out)')
      expect(transition).toContain('transform var(--dur-press) var(--ease-out)')
      expect(active.normal).toContain('transform: scale(0.97);')
      expect(
        ruleSelectorsWithDeclaration(css, 'transform var(--dur-press) var(--ease-out)')
      ).toEqual([selector])
      expect(ruleSelectorsWithDeclaration(css, 'transform: scale(')).toEqual([`${selector}:active`])
      expect(ruleSelectorsWithDeclaration(css, 'box-shadow')).not.toContain(selector)
    }
  })

  it('removes sidebar button press transforms for OS and in-app reduced motion', () => {
    for (const { css, selector } of pressableStylesheets) {
      const activeSelector = `${selector}:active`
      const inAppReducedMotionSelector = `:root[data-motion='reduced'] ${activeSelector}`
      const active = activeRuleDeclarations(css, activeSelector)

      expect(active.osReducedMotion).toContain('transform: none;')
      expect(rootRuleDeclaration(css, inAppReducedMotionSelector)).toContain('transform: none;')
    }
  })
})
