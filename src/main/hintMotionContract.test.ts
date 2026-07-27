import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const hintCss = readFileSync(join(mainDir, '../renderer/src/components/Hint.css'), 'utf8')
const motionTokens = readFileSync(join(mainDir, '../renderer/src/styles/tokens.css'), 'utf8')

function blockAfter(source: string, prelude: string): string {
  const start = source.indexOf(prelude)
  if (start === -1) return ''
  const open = source.indexOf('{', start + prelude.length)
  if (open === -1) return ''
  let depth = 1
  for (let cursor = open + 1; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++
    if (source[cursor] === '}') depth--
    if (depth === 0) return source.slice(open + 1, cursor)
  }
  return ''
}

describe('Hint motion contract', () => {
  it('keeps outer positioning transforms separate from the animated inner surface', () => {
    expect(blockAfter(hintCss, '.hint-bubble.right')).toContain('transform: translateY(-50%);')
    expect(blockAfter(hintCss, '.hint-bubble.bottom')).toContain('transform: translateX(-50%);')
    expect(blockAfter(hintCss, '.hint-bubble.top')).toContain('transform: translate(-50%, -100%);')

    expect(blockAfter(hintCss, '.hint-bubble.right .hint-surface')).toContain(
      'transform-origin: left center;'
    )
    expect(blockAfter(hintCss, '.hint-bubble.bottom .hint-surface')).toContain(
      'transform-origin: center top;'
    )
    expect(blockAfter(hintCss, '.hint-bubble.top .hint-surface')).toContain(
      'transform-origin: center bottom;'
    )
  })

  it('gives only eligible cold-pointer reveals one 150ms opacity-and-scale entry', () => {
    expect(blockAfter(motionTokens, ':root')).toContain('--dur-fast: 150ms;')
    expect(blockAfter(hintCss, '.hint-surface.hint-enter')).toContain(
      'animation: hint-in var(--dur-fast) var(--ease-out);'
    )
    const keyframes = blockAfter(hintCss, '@keyframes hint-in')
    const from = blockAfter(keyframes, 'from')
    const to = blockAfter(keyframes, 'to')
    expect(from).toContain('opacity: 0;')
    expect(from).toContain('transform: scale(0.96);')
    expect(to).toContain('opacity: 1;')
    expect(to).toContain('transform: scale(1);')
  })

  it('drops scale movement while retaining a fade under both reduced-motion paths', () => {
    const osReduced = blockAfter(hintCss, '@media (prefers-reduced-motion: reduce)')
    expect(blockAfter(osReduced, '.hint-surface.hint-enter')).toContain(
      'animation-name: hint-fade-in;'
    )
    expect(blockAfter(hintCss, ":root[data-motion='reduced'] .hint-surface.hint-enter")).toContain(
      'animation-name: hint-fade-in;'
    )

    const fadeKeyframes = blockAfter(hintCss, '@keyframes hint-fade-in')
    expect(fadeKeyframes).not.toContain('transform')
  })
})
