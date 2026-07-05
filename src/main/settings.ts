import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, PermissionMode, SettingsInfo } from '../shared/types'

// The four selectable default modes (design §5). 'bypass' is per-conversation
// only and is NEVER a valid default -- coerced away on read, rejected on write.
export const SELECTABLE_PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'accept-edits',
  'plan',
  'auto'
]

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
  // defaultPermissionMode is the single default (design §5). Coerce anything
  // outside the four selectable modes -- including a stray 'bypass' or a typo
  // from a future/downgraded version -- to the safe default.
  if (!SELECTABLE_PERMISSION_MODES.includes(merged.defaultPermissionMode)) {
    merged.defaultPermissionMode = 'accept-edits'
  }
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
  // Validate BEFORE persisting: 'bypass' is per-conversation only and must never
  // become a global default (design §6), and an unknown value must never be
  // written. Throw at the boundary (ipc.ts turns it into a rejected promise).
  if (
    patch.defaultPermissionMode !== undefined &&
    !SELECTABLE_PERMISSION_MODES.includes(patch.defaultPermissionMode)
  ) {
    throw new Error(
      `Invalid defaultPermissionMode: ${String(patch.defaultPermissionMode)} (not selectable)`
    )
  }
  const next = { ...getSettings(), ...patch }
  cache = next
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}

export function settingsInfo(): SettingsInfo {
  return { ...getSettings(), dataPath: app.getPath('userData') }
}
