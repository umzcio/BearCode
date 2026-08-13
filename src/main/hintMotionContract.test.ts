import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainDir = dirname(fileURLToPath(import.meta.url))
const hintCss = readFileSync(join(mainDir, '../renderer/src/components/Hint.css'), 'utf8')
const motionTokens = readFileSync(join(mainDir, '../renderer/src/styles/tokens.css'), 'utf8')
const sharedCss = readFileSync(join(mainDir, '../renderer/src/styles/shared.css'), 'utf8')

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
  it('keeps outer positioning transforms on the bubble, never on the animated surface', () => {
    expect(blockAfter(hintCss, '.hint-bubble.right')).toContain('transform: translateY(-50%);')
    expect(blockAfter(hintCss, '.hint-bubble.bottom')).toContain('transform: translateX(-50%);')
    expect(blockAfter(hintCss, '.hint-bubble.top')).toContain('transform: translate(-50%, -100%);')

    // The BUI enter is a pure fade (motion fidelity pass, plans/2026-08-12-
    // bui-motion-fidelity.md), so the surface carries no transform of its own —
    // positioning stays isolated on the bubble wrappers above.
    expect(blockAfter(hintCss, '.hint-surface.hint-enter')).not.toContain('transform')
  })

  it('gives only eligible cold-pointer reveals one 150ms pure-fade entry', () => {
    expect(blockAfter(motionTokens, ':root')).toContain('--dur-fast: 150ms;')
    expect(blockAfter(hintCss, '.hint-surface.hint-enter')).toContain(
      'animation: fade-in var(--dur-fast) var(--ease-out) both;'
    )
    // The keyframes come from the shared library, never a local duplicate.
    expect(hintCss).not.toContain('@keyframes')
    const keyframes = blockAfter(sharedCss, '@keyframes fade-in')
    expect(keyframes).toContain('opacity: 0;')
    expect(keyframes).toContain('opacity: 1;')
  })

  it('stays movement-free under both reduced-motion paths by construction', () => {
    // fade-in animates opacity only, so neither reduced-motion path needs a
    // local override: the OS path is already transform-free, and the in-app
    // :root[data-motion='reduced'] blanket rule (tokens.css) collapses the
    // duration. The contract is that the enter never grows movement back.
    const keyframes = blockAfter(sharedCss, '@keyframes fade-in')
    expect(keyframes.length).toBeGreaterThan(0)
    expect(keyframes).not.toContain('transform')
    expect(blockAfter(hintCss, '.hint-surface.hint-enter')).not.toContain('transform')
  })
})
