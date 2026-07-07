// Appearance settings: shared types + validators used by both main (settings
// persistence/validation) and the renderer (the Appearance UI + apply module).

export type ThemeMode = 'dark' | 'light' | 'system' | 'custom'
export type FontSize = 'small' | 'medium' | 'large'
export type ConversationWidth = 'default' | 'narrow' | 'wide'
export type ChatFont = 'sans' | 'serif'

// Custom theme is defined by three colors; every other token (surfaces,
// borders, hovers, dims) is derived from these in the apply module.
export interface CustomColors {
  bg: string
  fg: string
  accent: string
}

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system', 'custom']
export const FONT_SIZES: readonly FontSize[] = ['small', 'medium', 'large']
export const CONVERSATION_WIDTHS: readonly ConversationWidth[] = ['default', 'narrow', 'wide']
export const CHAT_FONTS: readonly ChatFont[] = ['sans', 'serif']

export const isThemeMode = (v: unknown): v is ThemeMode =>
  typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v)
export const isFontSize = (v: unknown): v is FontSize =>
  typeof v === 'string' && (FONT_SIZES as readonly string[]).includes(v)
export const isConversationWidth = (v: unknown): v is ConversationWidth =>
  typeof v === 'string' && (CONVERSATION_WIDTHS as readonly string[]).includes(v)
export const isChatFont = (v: unknown): v is ChatFont =>
  typeof v === 'string' && (CHAT_FONTS as readonly string[]).includes(v)

const HEX6 = /^#[0-9a-fA-F]{6}$/
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX6.test(v)

// Default custom palette seeds the pickers the first time a user opens Custom:
// the app's current dark base (bg=--bg-window, fg=--text, accent=--accent).
export const DEFAULT_CUSTOM_COLORS: CustomColors = {
  bg: '#1b1b1b',
  fg: '#e7e7e7',
  accent: '#4c8dff'
}

// Coerce persisted custom colors: each channel falls back to the default when
// missing or not a valid #rrggbb, so a hand-edited settings.json can't wedge
// the theme.
export function coerceCustomColors(raw: unknown): CustomColors {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    bg: isHexColor(o.bg) ? o.bg : DEFAULT_CUSTOM_COLORS.bg,
    fg: isHexColor(o.fg) ? o.fg : DEFAULT_CUSTOM_COLORS.fg,
    accent: isHexColor(o.accent) ? o.accent : DEFAULT_CUSTOM_COLORS.accent
  }
}
