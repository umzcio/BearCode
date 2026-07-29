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

type CssRule = {
  prelude: string
  body: string
  ancestors: string[]
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function withoutComments(css: string): string {
  let result = ''
  let quote = ''

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]
    const next = css[index + 1]

    if (quote) {
      result += character
      if (character === '\\') {
        result += next ?? ''
        index += 1
      } else if (character === quote) {
        quote = ''
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      result += character
      continue
    }

    if (character === '/' && next === '*') {
      index = css.indexOf('*/', index + 2)
      if (index === -1) break
      index += 1
      continue
    }

    result += character
  }

  return result
}

function closingBrace(css: string, openingIndex: number): number {
  let depth = 0
  let quote = ''

  for (let index = openingIndex; index < css.length; index += 1) {
    const character = css[index]

    if (quote) {
      if (character === '\\') {
        index += 1
      } else if (character === quote) {
        quote = ''
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  throw new Error('Unbalanced CSS braces')
}

function extractRules(css: string, ancestors: string[] = []): CssRule[] {
  const source = withoutComments(css)
  const rules: CssRule[] = []
  let preludeStart = 0

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue

    const prelude = source.slice(preludeStart, index).trim()
    const closeIndex = closingBrace(source, index)
    const body = source.slice(index + 1, closeIndex)

    if (prelude.startsWith('@')) {
      rules.push(...extractRules(body, [...ancestors, normalizeWhitespace(prelude)]))
    } else if (prelude) {
      rules.push({ prelude: normalizeWhitespace(prelude), body, ancestors })
    }

    index = closeIndex
    preludeStart = closeIndex + 1
  }

  return rules
}

function findRule(css: string, predicate: (rule: CssRule) => boolean): CssRule | undefined {
  return extractRules(css).find(predicate)
}

function pressableRule(kind: 'base' | 'active'): (rule: CssRule) => boolean {
  const suffix = kind === 'base' ? ')' : '):active:not(:disabled)'
  return ({ prelude }) => prelude.startsWith(':is(') && prelude.endsWith(suffix)
}

function expectFamilies(rule: CssRule | undefined, families: string[]): void {
  expect(rule).toBeDefined()
  const prelude = normalizeWhitespace(rule?.prelude ?? '')
  for (const family of families) {
    expect(prelude).toContain(normalizeWhitespace(family))
  }
}

function expectTransformNone(rule: CssRule | undefined): void {
  expect(rule).toBeDefined()
  expect(normalizeWhitespace(rule?.body ?? '')).toContain('transform: none')
}

const reducedMotionMedia = '@media (prefers-reduced-motion: reduce)'
const startingStyle = '@starting-style'
const disabledFamilies = [
  '.ap-actions button',
  '.ap-segmented button',
  '.plan-review-actions button',
  '.comment-composer-actions button',
  '.comment-bar-send',
  '.comment-bar-close',
  '.comment-del',
  '.foot-btn'
]

describe('Artifacts Pane motion CSS contract', () => {
  it('extracts a nested rule body without crossing an at-rule boundary', () => {
    const css = `
      @media (prefers-reduced-motion: reduce) {
        @starting-style {
          .comment-bar { transform: none; }
        }
      }
      .comment-bar { transform: translateY(-4px); }
    `

    const rule = findRule(
      css,
      ({ prelude, ancestors }) =>
        prelude === '.comment-bar' &&
        ancestors.join(' > ') === '@media (prefers-reduced-motion: reduce) > @starting-style'
    )

    expect(rule?.body).toContain('transform: none')
  })

  it('binds every pressable family to the shared base and active rules', () => {
    const baseRule = findRule(paneCss, pressableRule('base'))
    const activeRule = findRule(paneCss, pressableRule('active'))

    expectFamilies(baseRule, pressableFamilies)
    expectFamilies(activeRule, pressableFamilies)

    const baseBody = normalizeWhitespace(baseRule?.body ?? '')
    expect(baseBody).toContain('background-color var(--dur-fast) ease')
    expect(baseBody).toContain('color var(--dur-fast) ease')
    expect(baseBody).toContain('border-color var(--dur-fast) ease')
    expect(baseBody).toContain('transform var(--dur-press-release) var(--ease-out)')

    const activeBody = normalizeWhitespace(activeRule?.body ?? '')
    expect(activeBody).toContain('transform: scale(0.97)')
    expect(activeBody).toContain('transform var(--dur-press) var(--ease-out)')
  })

  it('keeps pressable movement disabled for disabled and reduced-motion states', () => {
    const disabledRule = findRule(
      paneCss,
      ({ prelude, ancestors }) =>
        ancestors.length === 0 && prelude.startsWith(':is(') && prelude.endsWith('):disabled')
    )
    expectFamilies(disabledRule, disabledFamilies)
    expectTransformNone(disabledRule)

    const osReducedActiveRule = findRule(
      paneCss,
      ({ prelude, ancestors }) =>
        ancestors.join(' > ') === reducedMotionMedia &&
        prelude.startsWith(':is(') &&
        prelude.endsWith('):active:not(:disabled)')
    )
    const inAppReducedActiveRule = findRule(
      paneCss,
      ({ prelude, ancestors }) =>
        ancestors.length === 0 &&
        prelude.startsWith(":root[data-motion='reduced'] :is(") &&
        prelude.endsWith('):active:not(:disabled)')
    )
    expectFamilies(osReducedActiveRule, pressableFamilies)
    expectFamilies(inAppReducedActiveRule, pressableFamilies)
    expectTransformNone(osReducedActiveRule)
    expectTransformNone(inAppReducedActiveRule)
  })

  it('keeps reduced-motion panel, comment, and status declarations in their own nested rules', () => {
    const cases = [
      {
        selector: '.ap-panel',
        duration: '--dur-fast',
        inAppPrelude: ":root[data-motion='reduced'] .ap-panel"
      },
      {
        selector: '.comment-bar',
        duration: '--dur-menu',
        inAppPrelude: ":root[data-motion='reduced'] .comment-bar"
      },
      {
        selector: '.plan-resolution-notice',
        duration: '--dur-fast',
        inAppPrelude: ":root[data-motion='reduced'] .plan-resolution-notice"
      }
    ]

    for (const { selector, duration, inAppPrelude } of cases) {
      const osReducedRule = findRule(
        paneCss,
        ({ prelude, ancestors }) =>
          prelude === selector && ancestors.join(' > ') === reducedMotionMedia
      )
      expectTransformNone(osReducedRule)
      expect(normalizeWhitespace(osReducedRule?.body ?? '')).toContain(`opacity var(${duration})`)

      const osStartingRule = findRule(
        paneCss,
        ({ prelude, ancestors }) =>
          prelude === selector &&
          ancestors.join(' > ') === `${reducedMotionMedia} > ${startingStyle}`
      )
      expectTransformNone(osStartingRule)

      const inAppRule = findRule(
        paneCss,
        ({ prelude, ancestors }) => ancestors.length === 0 && prelude.includes(inAppPrelude)
      )
      expectTransformNone(inAppRule)

      const inAppStartingRule = findRule(
        paneCss,
        ({ prelude, ancestors }) =>
          ancestors.join(' > ') === startingStyle && prelude.includes(inAppPrelude)
      )
      expectTransformNone(inAppStartingRule)
    }
  })

  it('rejects a family removed from the shared rule even when that selector remains elsewhere', () => {
    const cssWithMissingSharedFamily = paneCss.replace('  .version-chip,\n', '')
    const sharedRule = findRule(cssWithMissingSharedFamily, pressableRule('base'))

    expect(normalizeWhitespace(cssWithMissingSharedFamily)).toContain('.version-chip')
    expect(normalizeWhitespace(sharedRule?.prelude ?? '')).not.toContain('.version-chip')
  })

  it('forbids broad, collapsed, and hardcoded motion declarations in pane rules', () => {
    const declarations = extractRules(paneCss)
      .map(({ body }) => body)
      .join('\n')

    expect(declarations).not.toMatch(/\btransition\s*:\s*all\b/)
    expect(declarations).not.toMatch(/scale\(0\)/)
    expect(declarations).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/)
  })
})
