// Consent/enable state for hooks (design 2026-07-11-hooks-arc-design.md §5.1),
// persisted in the settings store exactly like the plugins/skills enable-set
// idiom. Global hooks are user-authored + trusted -> active by DEFAULT,
// unless the user has explicitly disabled them (hooksDisabledGlobal, bare
// names). Project/plugin hooks are foreign code -> inactive by DEFAULT,
// active only once the user has explicitly consented after seeing the
// command (hooksConsented, keyed "<scope>:<source>:<name>").
import { getSettings, setSettings } from '../settings'

type HookScope = 'global' | 'project' | 'plugin'

const consentKey = (scope: HookScope, source: string, name: string): string =>
  `${scope}:${source}:${name}`

export function isHookActive(
  rec: { scope: HookScope; plugin?: string; name: string },
  projectPath: string | null
): boolean {
  const s = getSettings()
  if (rec.scope === 'global') {
    return !(s.hooksDisabledGlobal ?? []).includes(rec.name)
  }
  const source = rec.scope === 'project' ? projectPath : rec.plugin
  if (!source) return false
  return (s.hooksConsented ?? []).includes(consentKey(rec.scope, source, rec.name))
}

export function setHookActive(scope: HookScope, source: string, name: string, on: boolean): void {
  const s = getSettings()
  if (scope === 'global') {
    const cur = s.hooksDisabledGlobal ?? []
    const next = on ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]))
    setSettings({ hooksDisabledGlobal: next })
    return
  }
  const key = consentKey(scope, source, name)
  const cur = s.hooksConsented ?? []
  const next = on ? Array.from(new Set([...cur, key])) : cur.filter((k) => k !== key)
  setSettings({ hooksConsented: next })
}
