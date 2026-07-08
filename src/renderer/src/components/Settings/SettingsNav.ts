export type SettingsPageId =
  | 'general'
  | 'permissions'
  | 'appearance'
  | 'providers'
  | 'models'
  | 'skills'
  | 'connectors'
  | 'memory'
  | 'integrations'
  | 'browser'
  | 'shortcuts'
  | 'feedback'

export interface SettingsNavItem {
  id: SettingsPageId
  label: string
  icon: string
}

export interface SettingsNavGroup {
  label: string | null
  items: SettingsNavItem[]
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Settings',
    items: [
      { id: 'general', label: 'General', icon: 'IconGear' },
      { id: 'permissions', label: 'Permissions', icon: 'IconShield' },
      { id: 'appearance', label: 'Appearance', icon: 'IconPalette' },
      { id: 'providers', label: 'Providers', icon: 'IconPlug' },
      { id: 'models', label: 'Models', icon: 'IconGrid' }
    ]
  },
  {
    label: 'Customize',
    items: [
      { id: 'skills', label: 'Skills', icon: 'IconScroll' },
      { id: 'connectors', label: 'Connectors', icon: 'IconBlocks' },
      { id: 'memory', label: 'Memory', icon: 'IconBrain' },
      { id: 'integrations', label: 'Integrations', icon: 'IconLink' },
      { id: 'browser', label: 'Browser', icon: 'IconGlobe' }
    ]
  }
]

export const SETTINGS_FOOTER: SettingsNavItem[] = [
  { id: 'shortcuts', label: 'Shortcuts', icon: 'IconKeyboard' },
  { id: 'feedback', label: 'Provide Feedback', icon: 'IconChat' }
]

export const FEEDBACK_URL = 'https://github.com/umzcio/BearCode/issues/new'
