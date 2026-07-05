import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, SettingsInfo } from '../shared/types'

const DEFAULTS: AppSettings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModelRef: null,
  defaultPermissionMode: 'accept-edits',
  disabledBuiltins: [],
  artifactReviewPolicy: 'request-review'
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

// Seed defaultPermissionMode from the retired autoApproveCommands boolean the
// first time settings load after upgrade, then drop the legacy key.
export function migrateSettings(raw: Record<string, unknown>): AppSettings {
  const { autoApproveCommands, ...rest } = raw as Record<string, unknown> & {
    autoApproveCommands?: boolean
  }
  const seeded =
    rest['defaultPermissionMode'] == null && autoApproveCommands !== undefined
      ? { ...rest, defaultPermissionMode: autoApproveCommands ? 'auto' : 'accept-edits' }
      : rest
  const merged = { ...DEFAULTS, ...seeded } as AppSettings
  // A malformed settings.json must never make the disabled set un-inspectable:
  // anything that is not a string[] collapses to []. Stale ids (a builtin removed
  // in an upgrade) are kept -- they are inert at merge time (exact-id filter) and
  // may correspond to a builtin the user disabled under another app version.
  const rawDisabled = (seeded as Record<string, unknown>)['disabledBuiltins']
  merged.disabledBuiltins = Array.isArray(rawDisabled)
    ? rawDisabled.filter((x): x is string => typeof x === 'string')
    : []
  // The review policy is a two-value enum; anything else in settings.json
  // (typo, downgrade from a future version) collapses to the safe default,
  // 'request-review' (design 3.3: Request Review is the recommended default).
  const rawPolicy = (seeded as Record<string, unknown>)['artifactReviewPolicy']
  merged.artifactReviewPolicy = rawPolicy === 'always-proceed' ? 'always-proceed' : 'request-review'
  return merged
}

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
    cache = migrateSettings(raw)
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cache = next
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}

export function settingsInfo(): SettingsInfo {
  return { ...getSettings(), dataPath: app.getPath('userData') }
}
