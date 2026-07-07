// Applies Appearance settings to the DOM: data-* attributes drive the CSS in
// tokens.css; Custom injects derived color vars; font size uses CSS zoom on the
// root. Called on app load and whenever settings change (store.applyAppearance).
import type { AppSettings } from '@shared/types'
import type { CustomColors } from '@shared/appearance'

// The subset of settings this module reads.
export type Appearance = Pick<
  AppSettings,
  'theme' | 'customColors' | 'fontSize' | 'conversationWidth' | 'reduceMotion' | 'chatFont'
>

const CUSTOM_VARS = [
  '--bg',
  '--bg-window',
  '--bg-sidebar',
  '--bg-raised',
  '--bg-hover',
  '--bg-active',
  '--border',
  '--border-soft',
  '--text',
  '--text-mid',
  '--text-dim',
  '--accent',
  '--accent-strong',
  '--wash',
  '--wash-strong'
]

const ZOOM: Record<Appearance['fontSize'], number> = { small: 0.9, medium: 1, large: 1.1 }

// sRGB relative luminance of a #rrggbb color (0 dark .. 1 light).
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function clearCustomVars(root: HTMLElement): void {
  for (const v of CUSTOM_VARS) root.style.removeProperty(v)
}

// Derive every surface/border/text token from the 3 custom colors via CSS
// color-mix (the browser evaluates the expressions). Surfaces step from bg
// toward fg; text-mid/dim step from fg toward bg -- so it works for a light OR
// dark custom base.
function applyCustom(root: HTMLElement, c: CustomColors): void {
  const dark = luminance(c.bg) < 0.5
  const mix = (a: string, b: string, pct: number): string =>
    `color-mix(in srgb, ${a}, ${b} ${pct}%)`
  root.style.setProperty('--bg-window', c.bg)
  root.style.setProperty('--bg', mix(c.bg, '#000000', dark ? 28 : 5))
  root.style.setProperty('--bg-sidebar', mix(c.bg, c.fg, 3))
  root.style.setProperty('--bg-raised', mix(c.bg, c.fg, 7))
  root.style.setProperty('--bg-hover', mix(c.bg, c.fg, 10))
  root.style.setProperty('--bg-active', mix(c.bg, c.fg, 15))
  root.style.setProperty('--border', mix(c.bg, c.fg, 20))
  root.style.setProperty('--border-soft', mix(c.bg, c.fg, 11))
  root.style.setProperty('--text', c.fg)
  root.style.setProperty('--text-mid', mix(c.fg, c.bg, 32))
  root.style.setProperty('--text-dim', mix(c.fg, c.bg, 55))
  root.style.setProperty('--accent', c.accent)
  root.style.setProperty('--accent-strong', mix(c.accent, c.fg, 12))
  root.style.setProperty('--wash', mix('transparent', c.fg, 5))
  root.style.setProperty('--wash-strong', mix('transparent', c.fg, 10))
}

const systemPrefersDark = (): boolean =>
  window.matchMedia('(prefers-color-scheme: dark)').matches

// Resolve the effective base ('dark'|'light') for data-theme. Custom picks its
// base from the bg's luminance so non-overridden tokens stay sensible.
function resolveBase(a: Appearance): 'dark' | 'light' {
  if (a.theme === 'light') return 'light'
  if (a.theme === 'dark') return 'dark'
  if (a.theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return luminance(a.customColors.bg) < 0.5 ? 'dark' : 'light'
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolveBase(a))
  root.setAttribute('data-width', a.conversationWidth)
  root.setAttribute('data-chat-font', a.chatFont)
  root.setAttribute('data-motion', a.reduceMotion ? 'reduced' : 'system')
  root.style.setProperty('zoom', String(ZOOM[a.fontSize] ?? 1))
  if (a.theme === 'custom') applyCustom(root, a.customColors)
  else clearCustomVars(root)
}

// Re-apply on OS theme change while in 'system' mode. Returns an unsubscribe.
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null
export function watchSystemTheme(getAppearance: () => Appearance): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  if (mediaListener) mq.removeEventListener('change', mediaListener)
  mediaListener = () => {
    const a = getAppearance()
    if (a.theme === 'system') applyAppearance(a)
  }
  mq.addEventListener('change', mediaListener)
  return () => {
    if (mediaListener) mq.removeEventListener('change', mediaListener)
    mediaListener = null
  }
}
