import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))

type CssRule = {
  selectors: string[]
  declarations: string
}

function cssRules(stylesheet: string, recursive = true): CssRule[] {
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
      if (recursive) rules.push(...cssRules(declarations))
    } else {
      rules.push({
        selectors: selectorList.split(',').map((selector) => selector.trim()),
        declarations
      })
    }

    ruleStart = cursor
  }

  return rules
}

function exactRuleDeclarations(stylesheet: string, selector: string): string[] {
  return cssRules(stylesheet, false)
    .filter((rule) => rule.selectors.length === 1 && rule.selectors[0] === selector)
    .map((rule) => rule.declarations)
}

function ruleDeclarations(stylesheet: string, selector: string): string {
  const declarations = exactRuleDeclarations(stylesheet, selector)
  if (declarations.length !== 1) {
    throw new Error(`Expected exactly one CSS rule for ${selector}, found ${declarations.length}`)
  }
  return declarations[0]
}

function atRuleDeclarations(stylesheet: string, atRule: string, selector: string): string[] {
  const declarations: string[] = []
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
    if (selectorList.startsWith(atRule)) {
      declarations.push(
        ...exactRuleDeclarations(stylesheet.slice(openBrace + 1, cursor - 1), selector)
      )
    }

    ruleStart = cursor
  }

  return declarations
}

function atRuleDeclaration(stylesheet: string, atRule: string, selector: string): string {
  const declarations = atRuleDeclarations(stylesheet, atRule, selector)
  if (declarations.length !== 1) {
    throw new Error(
      `Expected exactly one ${atRule} CSS rule for ${selector}, found ${declarations.length}`
    )
  }
  return declarations[0]
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
      const transition = ruleDeclarations(css, selector)
      const active = ruleDeclarations(css, `${selector}:active`)

      expect(transition).toContain('background var(--dur-fast) var(--ease-out)')
      expect(transition).toContain('color var(--dur-fast) var(--ease-out)')
      expect(transition).toContain('transform var(--dur-press) var(--ease-out)')
      expect(active).toContain('transform: scale(0.97);')
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

      expect(
        atRuleDeclaration(css, '@media (prefers-reduced-motion: reduce)', activeSelector)
      ).toContain('transform: none;')
      expect(ruleDeclarations(css, inAppReducedMotionSelector)).toContain('transform: none;')
    }
  })
})
