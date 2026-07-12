// Settings-backed enabled-set for plugins. Default DISABLED (a freshly
// installed plugin never auto-activates). Mirrors mcpEnabledServers' string[]
// idiom; key is "<scope>:<name>".
import { getSettings, setSettings } from '../settings'

const key = (scope: 'global' | 'project', name: string): string => `${scope}:${name}`

export function isPluginEnabled(scope: 'global' | 'project', name: string): boolean {
  return (getSettings().pluginsEnabled ?? []).includes(key(scope, name))
}

export function setPluginEnabled(scope: 'global' | 'project', name: string, on: boolean): void {
  const cur = new Set(getSettings().pluginsEnabled ?? [])
  if (on) cur.add(key(scope, name))
  else cur.delete(key(scope, name))
  setSettings({ pluginsEnabled: [...cur] })
}
