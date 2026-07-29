import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const paneCss = readFileSync(join(mainDir, '../renderer/src/components/ArtifactsPane.css'), 'utf8')
const browserPaneCss = readFileSync(
  join(mainDir, '../renderer/src/components/Browser/BrowserPane.css'),
  'utf8'
)

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
  '.comment-fab',
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

function splitSelectorList(prelude: string): string[] {
  const selectors: string[] = []
  let parentheses = 0
  let brackets = 0
  let quote = ''
  let selectorStart = 0

  for (let index = 0; index < prelude.length; index += 1) {
    const character = prelude[index]

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
    } else if (character === '(') {
      parentheses += 1
    } else if (character === ')') {
      parentheses -= 1
    } else if (character === '[') {
      brackets += 1
    } else if (character === ']') {
      brackets -= 1
    } else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(normalizeWhitespace(prelude.slice(selectorStart, index)))
      selectorStart = index + 1
    }
  }

  selectors.push(normalizeWhitespace(prelude.slice(selectorStart)))
  return selectors
}

function closingParenthesis(value: string, openingIndex: number): number {
  let depth = 0
  let quote = ''

  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index]

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
    } else if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  throw new Error('Unbalanced selector parentheses')
}

function familySelectors(rule: CssRule): string[] {
  const isIndex = rule.prelude.indexOf(':is(')
  if (isIndex === -1) return splitSelectorList(rule.prelude)

  const openingIndex = isIndex + ':is'.length
  const closeIndex = closingParenthesis(rule.prelude, openingIndex)
  return splitSelectorList(rule.prelude.slice(openingIndex + 1, closeIndex))
}

function pressableRule(kind: 'base' | 'active'): (rule: CssRule) => boolean {
  const suffix = kind === 'base' ? ')' : '):active:not(:disabled)'
  return ({ prelude }) => prelude.startsWith(':is(') && prelude.endsWith(suffix)
}

function expectFamilies(rule: CssRule | undefined, families: string[]): void {
  expect(rule).toBeDefined()
  const selectors = familySelectors(rule as CssRule)
  for (const family of families) {
    expect(selectors).toContain(normalizeWhitespace(family))
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

function expectReducedSurfaceRules(css: string): void {
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

  const osClosingPanelRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      prelude === ".ap-panel[data-state='closing']" && ancestors.join(' > ') === reducedMotionMedia
  )
  expectTransformNone(osClosingPanelRule)

  const inAppPanelSelector = ":root[data-motion='reduced'] .ap-panel"
  const inAppClosingPanelSelector = ":root[data-motion='reduced'] .ap-panel[data-state='closing']"
  const inAppPanelRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.length === 0 && splitSelectorList(prelude).includes(inAppPanelSelector)
  )
  expect(inAppPanelRule).toBeDefined()
  expect(splitSelectorList(inAppPanelRule?.prelude ?? '')).toContain(inAppClosingPanelSelector)
  expectTransformNone(inAppPanelRule)

  for (const { selector, duration, inAppPrelude } of cases) {
    const osReducedRule = findRule(
      css,
      ({ prelude, ancestors }) =>
        prelude === selector && ancestors.join(' > ') === reducedMotionMedia
    )
    expectTransformNone(osReducedRule)
    expect(normalizeWhitespace(osReducedRule?.body ?? '')).toContain(`opacity var(${duration})`)

    const osStartingRule = findRule(
      css,
      ({ prelude, ancestors }) =>
        prelude === selector && ancestors.join(' > ') === `${reducedMotionMedia} > ${startingStyle}`
    )
    expectTransformNone(osStartingRule)

    const inAppRule = findRule(
      css,
      ({ prelude, ancestors }) =>
        ancestors.length === 0 && splitSelectorList(prelude).includes(inAppPrelude)
    )
    expectTransformNone(inAppRule)

    const inAppStartingRule = findRule(
      css,
      ({ prelude, ancestors }) =>
        ancestors.join(' > ') === startingStyle && splitSelectorList(prelude).includes(inAppPrelude)
    )
    expectTransformNone(inAppStartingRule)
  }
}

function expectEntryCueRules(css: string, selector: string): void {
  const cues = {
    '.comment-bar': {
      duration: '--dur-menu',
      startingTransform: 'translateY(-4px)'
    },
    '.plan-resolution-notice': {
      duration: '--dur-fast',
      startingTransform: 'translateY(2px)'
    },
    '.comment-row': {
      duration: '--dur-fast',
      startingTransform: 'translateY(2px)'
    },
    '.plan-comment-item': {
      duration: '--dur-fast',
      startingTransform: 'translateY(2px)'
    }
  } as const
  const cue = cues[selector as keyof typeof cues]
  expect(cue).toBeDefined()

  const baseRule = findRule(
    css,
    ({ prelude, body, ancestors }) =>
      ancestors.length === 0 &&
      splitSelectorList(prelude).includes(selector) &&
      normalizeWhitespace(body).includes('opacity: 1')
  )
  const entryRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.join(' > ') === startingStyle && splitSelectorList(prelude).includes(selector)
  )

  expect(baseRule).toBeDefined()
  expect(entryRule).toBeDefined()

  const baseBody = normalizeWhitespace(baseRule?.body ?? '')
  expect(baseBody).toContain('opacity: 1')
  expect(baseBody).toContain('transform: translateY(0)')
  expect(baseBody).toContain(`opacity var(${cue.duration}) var(--ease-out)`)
  expect(baseBody).toContain(`transform var(${cue.duration}) var(--ease-out)`)

  const entryBody = normalizeWhitespace(entryRule?.body ?? '')
  expect(entryBody).toContain('opacity: 0')
  expect(entryBody).toContain(`transform: ${cue.startingTransform}`)
}

function expectReducedEntryCueRules(css: string, selector: string): void {
  const osRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.join(' > ') === reducedMotionMedia && splitSelectorList(prelude).includes(selector)
  )
  const osStartingRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.join(' > ') === `${reducedMotionMedia} > ${startingStyle}` &&
      splitSelectorList(prelude).includes(selector)
  )
  const inAppSelector = `:root[data-motion='reduced'] ${selector}`
  const inAppRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.length === 0 && splitSelectorList(prelude).includes(inAppSelector)
  )
  const inAppStartingRule = findRule(
    css,
    ({ prelude, ancestors }) =>
      ancestors.join(' > ') === startingStyle && splitSelectorList(prelude).includes(inAppSelector)
  )

  const osBody = normalizeWhitespace(osRule?.body ?? '')
  expect(osBody).toContain('transform: none')
  expect(osBody).toContain('transition: opacity var(--dur-fast) var(--ease-out)')
  expect(normalizeWhitespace(osStartingRule?.body ?? '')).toContain('transform: none')
  expectTransformNone(inAppRule)
  expectTransformNone(inAppStartingRule)
}

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

  it('normalizes selector whitespace before comparing selector-list members', () => {
    const css = `
      :is(
        .ap-actions    button,
        .ap-tab
      ) { transform: scale(0.97); }
    `
    const rule = findRule(css, pressableRule('base'))

    expect(() => expectFamilies(rule, ['.ap-actions button', '.ap-tab'])).not.toThrow()
  })

  it('does not accept a lookalike selector as exact family membership', () => {
    const rule = findRule(
      ':is(.ap-tab-lookalike, .version-chip) { transform: scale(0.97); }',
      pressableRule('base')
    )

    expect(() => expectFamilies(rule, ['.ap-tab'])).toThrow()
  })

  it('ignores comments containing braces while extracting rules', () => {
    const css = `
      /* A removed rule looked like .old { transform: none; } */
      .target { transform: translateY(2px); }
    `

    expect(findRule(css, ({ prelude }) => prelude === '.target')?.body).toContain('translateY(2px)')
  })

  it('ignores quoted braces while balancing a declaration body', () => {
    const css = `
      .target { content: "}"; transform: translateY(2px); }
      .after { content: "{"; opacity: 1; }
    `

    expect(findRule(css, ({ prelude }) => prelude === '.target')?.body).toContain('translateY(2px)')
    expect(findRule(css, ({ prelude }) => prelude === '.after')?.body).toContain('opacity: 1')
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

  it('reserves the comment button transform for press feedback', () => {
    const allowedTransforms = new Set(['scale(0.97)', 'none'])
    const fabRules = extractRules(paneCss).filter((rule) =>
      familySelectors(rule).includes('.comment-fab')
    )

    expect(fabRules.length).toBeGreaterThan(0)
    for (const rule of fabRules) {
      const declarations = rule.body.matchAll(/(?:^|;)\s*transform\s*:\s*([^;]+)/g)
      for (const declaration of declarations) {
        expect(allowedTransforms).toContain(declaration[1].trim())
      }
    }
  })

  it('keeps reduced-motion panel, comment, and status declarations in their own nested rules', () => {
    expectReducedSurfaceRules(paneCss)
  })

  it('fades browser feedback only after mount and removes that transition under reduced motion', () => {
    const baseRule = findRule(
      browserPaneCss,
      ({ prelude, ancestors }) => prelude === '.browser-pane-state' && ancestors.length === 0
    )
    const startingRule = findRule(
      browserPaneCss,
      ({ prelude, ancestors }) =>
        prelude === '.browser-pane-state' && ancestors.join(' > ') === startingStyle
    )
    const osReducedRule = findRule(
      browserPaneCss,
      ({ prelude, ancestors }) =>
        prelude === '.browser-pane-state' && ancestors.join(' > ') === reducedMotionMedia
    )
    const inAppReducedRule = findRule(
      browserPaneCss,
      ({ prelude, ancestors }) =>
        prelude === ":root[data-motion='reduced'] .browser-pane-state" && ancestors.length === 0
    )

    const baseBody = normalizeWhitespace(baseRule?.body ?? '')
    expect(baseBody).toContain('opacity: 1')
    expect(baseBody).toContain('transition: opacity var(--dur-fast) var(--ease-out)')
    expect(baseBody).not.toContain('transform')

    const startingBody = normalizeWhitespace(startingRule?.body ?? '')
    expect(startingBody).toContain('opacity: 0')
    expect(startingBody).not.toContain('transform')

    expect(normalizeWhitespace(osReducedRule?.body ?? '')).toContain('transition: none')
    expect(normalizeWhitespace(inAppReducedRule?.body ?? '')).toContain('transition: none')
  })

  it('rejects removal of the exact OS reduced-motion closing-panel rule', () => {
    const cssWithoutClosingPanelRule = paneCss.replace(
      "  .ap-panel[data-state='closing'] {\n    transform: none;\n    opacity: 0;\n  }",
      "  .ap-panel[data-state='closed'] {\n    transform: none;\n    opacity: 0;\n  }"
    )
    expect(cssWithoutClosingPanelRule).not.toBe(paneCss)

    expect(() => expectReducedSurfaceRules(cssWithoutClosingPanelRule)).toThrow()
  })

  it('rejects removal of the exact in-app reduced-motion closing-panel selector', () => {
    const cssWithoutClosingPanelSelector = paneCss.replace(
      ":root[data-motion='reduced'] .ap-panel[data-state='closing'] {",
      ":root[data-motion='reduced'] .ap-panel[data-state='closed'] {"
    )
    expect(cssWithoutClosingPanelSelector).not.toBe(paneCss)

    expect(() => expectReducedSurfaceRules(cssWithoutClosingPanelSelector)).toThrow()
  })

  it('keeps normal comment and status entry cues bound to their own rules', () => {
    expectEntryCueRules(paneCss, '.comment-bar')
    expectEntryCueRules(paneCss, '.plan-resolution-notice')
  })

  it('cues newly inserted comment rows without movement under reduced motion', () => {
    for (const selector of ['.comment-row', '.plan-comment-item']) {
      expectEntryCueRules(paneCss, selector)
      expectReducedEntryCueRules(paneCss, selector)
    }
  })

  it('limits the comment tooltip hover to fine pointers and mirrors it for keyboard focus', () => {
    const tooltipRule = findRule(
      paneCss,
      ({ prelude, ancestors }) => prelude === '.comment-fab::before' && ancestors.length === 0
    )
    const hoverRule = findRule(
      paneCss,
      ({ prelude, ancestors }) =>
        prelude === '.comment-fab:hover::before' &&
        ancestors.join(' > ') === '@media (hover: hover) and (pointer: fine)'
    )
    const broadHoverRule = findRule(
      paneCss,
      ({ prelude, ancestors }) => prelude === '.comment-fab:hover::before' && ancestors.length === 0
    )
    const focusRule = findRule(
      paneCss,
      ({ prelude, ancestors }) => prelude === '.comment-fab:focus-visible' && ancestors.length === 0
    )
    const focusTooltipRule = findRule(
      paneCss,
      ({ prelude, ancestors }) =>
        prelude === '.comment-fab:focus-visible::before' && ancestors.length === 0
    )

    expect(normalizeWhitespace(tooltipRule?.body ?? '')).toContain(
      'transition: opacity var(--dur-fast) ease'
    )
    expect(hoverRule).toBeDefined()
    expect(normalizeWhitespace(hoverRule?.body ?? '')).toContain('opacity: 1')
    expect(broadHoverRule).toBeUndefined()
    expect(normalizeWhitespace(focusRule?.body ?? '')).toContain(
      'outline: 2px solid var(--ap-accent-blue)'
    )
    expect(normalizeWhitespace(focusTooltipRule?.body ?? '')).toContain('opacity: 1')
  })

  it('rejects a comment entry cue with the wrong normal transform duration', () => {
    const cssWithWrongDuration = paneCss.replace(
      'transform var(--dur-menu) var(--ease-out);',
      'transform var(--dur-fast) var(--ease-out);'
    )
    expect(cssWithWrongDuration).not.toBe(paneCss)

    expect(() => expectEntryCueRules(cssWithWrongDuration, '.comment-bar')).toThrow()
  })

  it('rejects a status entry cue with the wrong starting transform', () => {
    const cssWithWrongStartingTransform = paneCss.replace(
      'transform: translateY(2px);',
      'transform: none;'
    )
    expect(cssWithWrongStartingTransform).not.toBe(paneCss)

    expect(() =>
      expectEntryCueRules(cssWithWrongStartingTransform, '.plan-resolution-notice')
    ).toThrow()
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
