// Skills enable/disable state (design 4.3), persisted in the app settings store
// exactly like the MCP enable/trust sets (mcp/store.ts). A skill is enabled
// unless its name is in the disabled-set: global names in skillsDisabledGlobal,
// project names in skillsDisabledProject[projectPath].
import { getSettings, setSettings } from '../settings'

export function isSkillEnabled(
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): boolean {
  const s = getSettings()
  if (source === 'global') return !(s.skillsDisabledGlobal ?? []).includes(name)
  if (!projectPath) return true
  return !((s.skillsDisabledProject ?? {})[projectPath] ?? []).includes(name)
}

export function setSkillEnabled(
  name: string,
  source: 'project' | 'global',
  projectPath: string | null,
  enabled: boolean
): void {
  const s = getSettings()
  if (source === 'global') {
    const cur = s.skillsDisabledGlobal ?? []
    const next = enabled ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]))
    setSettings({ skillsDisabledGlobal: next })
    return
  }
  if (!projectPath) return
  const map = s.skillsDisabledProject ?? {}
  const cur = map[projectPath] ?? []
  const nextList = enabled ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]))
  setSettings({ skillsDisabledProject: { ...map, [projectPath]: nextList } })
}

export function disabledSkillNames(projectPath: string | null): {
  global: string[]
  project: string[]
} {
  const s = getSettings()
  return {
    global: [...(s.skillsDisabledGlobal ?? [])],
    project: projectPath ? [...((s.skillsDisabledProject ?? {})[projectPath] ?? [])] : []
  }
}
