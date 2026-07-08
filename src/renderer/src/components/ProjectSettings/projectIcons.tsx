import type { JSX } from 'react'
import {
  IconFolder,
  IconGrid,
  IconBlocks,
  IconBrain,
  IconGlobe,
  IconScroll,
  IconChat,
  IconShield,
  IconPalette,
  IconPlug,
  IconLink
} from '../icons'

// The curated folder-icon set (name → component). Shared by the Project
// Settings modal (the picker) and the sidebar (rendering a project's chosen
// icon) so a persisted icon name resolves the same everywhere. IconFolder is
// the default when a project has no icon or an unknown one.
export const PROJECT_ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  IconFolder,
  IconGrid,
  IconBlocks,
  IconBrain,
  IconGlobe,
  IconScroll,
  IconChat,
  IconShield,
  IconPalette,
  IconPlug,
  IconLink
}

export function projectIcon(
  name: string | null | undefined
): (p: { size?: number }) => JSX.Element {
  return (name && PROJECT_ICONS[name]) || IconFolder
}
