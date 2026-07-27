import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ruleDeclarations(stylesheet: string, selector: string): string {
  const match = stylesheet.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`))
  if (!match) throw new Error(`Expected CSS rule for ${selector}`)
  return match[1]
}

function atRuleBlockContaining(stylesheet: string, atRule: string, selector: string): string {
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
    if (block.includes(selector)) return block
    atRuleStart = stylesheet.indexOf(atRule, cursor)
  }

  throw new Error(`Expected ${atRule} block containing ${selector}`)
}

function ruleSelectorsWithDeclaration(stylesheet: string, declaration: string): string[] {
  const selectors: string[] = []
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
      selectors.push(...ruleSelectorsWithDeclaration(declarations, declaration))
    } else if (declarations.includes(declaration)) {
      selectors.push(...selectorList.split(',').map((selector) => selector.trim()))
    }

    ruleStart = cursor
  }

  return selectors
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
      const osReducedMotion = atRuleBlockContaining(
        css,
        '@media (prefers-reduced-motion: reduce)',
        activeSelector
      )
      const inAppReducedMotionSelector = `:root[data-motion='reduced'] ${activeSelector}`

      expect(ruleDeclarations(osReducedMotion, activeSelector)).toContain('transform: none;')
      expect(ruleDeclarations(css, inAppReducedMotionSelector)).toContain('transform: none;')
    }
  })
})
