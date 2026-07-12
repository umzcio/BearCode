import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  AppSettings,
  CustomModel,
  ProjectSettings,
  ProviderId,
  SettingsInfo
} from '../shared/types'
import {
  isSttBackend,
  isSecurityPreset,
  isFileAccessPolicy,
  isTerminalAutoExec
} from '../shared/types'
import type { PricingMap } from '../shared/pricing'
import { isEffortLevel } from '../shared/effort'
import { isSelectableDefaultMode, SELECTABLE_DEFAULT_MODES } from '../shared/permissionMode'
import {
  isThemeMode,
  isFontSize,
  isConversationWidth,
  isChatFont,
  coerceCustomColors,
  DEFAULT_CUSTOM_COLORS
} from '../shared/appearance'

// The four selectable default modes (design §5). 'bypass' is per-conversation
// only and is NEVER a valid default -- coerced away on read, rejected on write.
// Single source of truth in shared/permissionMode.ts (also used by F9's
// per-project default coercion) so the two can never drift.
export const SELECTABLE_PERMISSION_MODES = SELECTABLE_DEFAULT_MODES

const DEFAULTS: AppSettings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModelRef: null,
  defaultPermissionMode: 'accept-edits',
  disabledBuiltins: [],
  artifactReviewPolicy: 'request-review',
  defaultEffort: 'adaptive',
  defaultThinking: true,
  sidebarGroupBy: 'project',
  sidebarSort: 'updated',
  sidebarShowArchived: false,
  sidebarSubtitle: 'none',
  theme: 'dark',
  customColors: DEFAULT_CUSTOM_COLORS,
  fontSize: 'medium',
  conversationWidth: 'default',
  reduceMotion: false,
  chatFont: 'sans',
  modelPricing: {},
  modelPricingSyncedAt: 0,
  sttBackend: 'openai',
  profileName: '',
  profileCallMe: '',
  customInstructions: '',
  disabledModels: [],
  customModels: [],
  securityPreset: 'custom',
  fileAccessPolicy: 'deny',
  terminalAutoExec: 'auto',
  browserEnabled: false,
  browserAllowlist: [],
  browserBlocklist: [],
  mcpEnabled: false,
  mcpEnabledServers: [],
  mcpTrustedProjectServers: {},
  mcpUntrustedGlobalServers: [],
  mcpSpawnConsented: [],
  githubClientId: '',
  skillsDisabledGlobal: [],
  skillsDisabledProject: {},
  pluginsEnabled: [],
  marketplaces: []
}

// Custom models may only target the four first-party curated providers. Ollama
// is fully dynamic/local and manages its own catalog, so a hand-edited
// settings.json cannot inject a phantom `ollama/*` model into the picker.
const CUSTOM_MODEL_PROVIDER_IDS = new Set<ProviderId>([
  'anthropic',
  'openai',
  'google',
  'openrouter'
])

// Keep only well-formed custom models: a valid (non-Ollama) provider id, a
// non-empty id and label, and a finite positive contextWindow. Anything else
// (bad provider, empty id, non-numeric/negative window) is dropped so a
// malformed settings.json or a bad Add-model payload can never poison the merge.
function coerceCustomModels(raw: unknown): CustomModel[] {
  if (!Array.isArray(raw)) return []
  const out: CustomModel[] = []
  for (const v of raw) {
    if (v == null || typeof v !== 'object') continue
    const { provider, id, label, contextWindow } = v as Record<string, unknown>
    if (
      typeof provider === 'string' &&
      CUSTOM_MODEL_PROVIDER_IDS.has(provider as ProviderId) &&
      typeof id === 'string' &&
      id.length > 0 &&
      typeof label === 'string' &&
      label.length > 0 &&
      typeof contextWindow === 'number' &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
    ) {
      out.push({ provider: provider as ProviderId, id, label, contextWindow })
    }
  }
  return out
}

export function coerceStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

// Connectors/MCP: per-key string-array map, e.g. mcpTrustedProjectServers
// (projectPath -> trusted server names). Non-object input -> {}; each value
// is coerced independently via coerceStringArray so a malformed entry never
// poisons the whole map.
export function coerceStringArrayMap(raw: unknown): Record<string, string[]> {
  if (raw == null || typeof raw !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = coerceStringArray(v)
  return out
}

// F9: keep only well-formed ProjectSettings fields (the new-project template).
// Strings for color/icon/modelRef; effort/mode validated against their enums.
// Anything else is omitted so a malformed value can never seed a bad project.
function coerceProjectSettings(raw: unknown): ProjectSettings | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: ProjectSettings = {}
  if (typeof r.color === 'string' || r.color === null) out.color = r.color as string | null
  if (typeof r.icon === 'string' || r.icon === null) out.icon = r.icon as string | null
  if (typeof r.defaultModelRef === 'string' || r.defaultModelRef === null) {
    out.defaultModelRef = r.defaultModelRef as string | null
  }
  if (isEffortLevel(r.defaultEffort)) out.defaultEffort = r.defaultEffort
  // Selectable-default guard, NOT isPermissionMode: 'bypass' can never be a
  // default, so it (and garbage) is dropped from the new-project template.
  if (isSelectableDefaultMode(r.defaultPermissionMode)) {
    out.defaultPermissionMode = r.defaultPermissionMode
  }
  return out
}

// Keep only well-formed pricing entries: an object of modelRef -> { inputPer1M,
// outputPer1M } where both are finite, >= 0 numbers. Anything else (garbage
// value, non-numeric or negative price, non-object) is dropped so a malformed
// settings.json or a bad Sync payload can never poison cost math.
function coercePricing(raw: unknown): PricingMap {
  if (raw == null || typeof raw !== 'object') return {}
  const out: PricingMap = {}
  for (const [ref, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val == null || typeof val !== 'object') continue
    const { inputPer1M, outputPer1M } = val as { inputPer1M?: unknown; outputPer1M?: unknown }
    if (
      typeof inputPer1M === 'number' &&
      typeof outputPer1M === 'number' &&
      Number.isFinite(inputPer1M) &&
      Number.isFinite(outputPer1M) &&
      inputPer1M >= 0 &&
      outputPer1M >= 0
    ) {
      out[ref] = { inputPer1M, outputPer1M }
    }
  }
  return out
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
  // E6 defaults. defaultEffort coerces to 'adaptive' for anything outside the
  // six levels (typo / downgrade). defaultThinking coerces to a strict boolean,
  // defaulting on to preserve today's always-thinking behavior.
  if (!isEffortLevel(merged.defaultEffort)) merged.defaultEffort = 'adaptive'
  merged.defaultThinking =
    (seeded as Record<string, unknown>)['defaultThinking'] === false ? false : true
  const groupByOk = ['project', 'environment', 'status', 'none']
  const sortOk = ['updated', 'alpha', 'created']
  const subtitleOk = ['none', 'worktree']
  if (!groupByOk.includes(merged.sidebarGroupBy)) merged.sidebarGroupBy = 'project'
  if (!sortOk.includes(merged.sidebarSort)) merged.sidebarSort = 'updated'
  if (!subtitleOk.includes(merged.sidebarSubtitle)) merged.sidebarSubtitle = 'none'
  merged.sidebarShowArchived = (seeded as Record<string, unknown>)['sidebarShowArchived'] === true
  // Appearance: coerce each field to a valid enum/shape, falling back to the
  // dark defaults so a malformed settings.json can never wedge the theme.
  const s = seeded as Record<string, unknown>
  if (!isThemeMode(merged.theme)) merged.theme = 'dark'
  merged.customColors = coerceCustomColors(s['customColors'])
  if (!isFontSize(merged.fontSize)) merged.fontSize = 'medium'
  if (!isConversationWidth(merged.conversationWidth)) merged.conversationWidth = 'default'
  merged.reduceMotion = s['reduceMotion'] === true
  if (!isChatFont(merged.chatFont)) merged.chatFont = 'sans'
  // Pricing: drop any malformed entries; missing/invalid syncedAt -> 0 (bundled
  // defaults). Optional & additive -- older settings simply coerce to {} / 0.
  merged.modelPricing = coercePricing(s['modelPricing'])
  merged.modelPricingSyncedAt =
    typeof s['modelPricingSyncedAt'] === 'number' ? s['modelPricingSyncedAt'] : 0
  // Voice STT backend (E5): a two-value enum; anything outside it (missing,
  // typo, downgrade from a future version) collapses to 'openai', the
  // guaranteed-working default. Optional & additive.
  if (!isSttBackend(merged.sttBackend)) merged.sttBackend = 'openai'
  // Profile + custom instructions (F6): optional string fields; coerce any
  // non-string persisted value (including missing) to '' so a malformed
  // settings.json can never leak a non-string into the system prompt.
  merged.profileName = typeof s['profileName'] === 'string' ? s['profileName'] : ''
  merged.profileCallMe = typeof s['profileCallMe'] === 'string' ? s['profileCallMe'] : ''
  merged.customInstructions =
    typeof s['customInstructions'] === 'string' ? s['customInstructions'] : ''
  // F7 model management: optional & additive. A non-array disabledModels or a
  // malformed customModels collapses to [] so the registry merge stays safe.
  merged.disabledModels = coerceStringArray(s['disabledModels'])
  merged.customModels = coerceCustomModels(s['customModels'])
  // F8 Agent Settings: coerce each enum to a valid value, falling back to the
  // BEHAVIOR-PRESERVING defaults (custom / deny / auto) so a malformed or
  // downgraded settings.json can never loosen the security posture.
  if (!isSecurityPreset(merged.securityPreset)) merged.securityPreset = 'custom'
  if (!isFileAccessPolicy(merged.fileAccessPolicy)) merged.fileAccessPolicy = 'deny'
  if (!isTerminalAutoExec(merged.terminalAutoExec)) merged.terminalAutoExec = 'auto'
  // F9 new-project template: coerce to a clean ProjectSettings or drop entirely.
  merged.newProjectDefaults = coerceProjectSettings(s['newProjectDefaults'])
  // F4 browser tool: the L0 enable gate is a strict boolean (off by default, so
  // a malformed/garbage persisted value can never accidentally enable the live
  // browser). The domain lists collapse to [] on anything but a string array.
  merged.browserEnabled = s['browserEnabled'] === true
  merged.browserAllowlist = coerceStringArray(s['browserAllowlist'])
  merged.browserBlocklist = coerceStringArray(s['browserBlocklist'])
  merged.mcpEnabled = s['mcpEnabled'] === true
  merged.mcpEnabledServers = coerceStringArray(s['mcpEnabledServers'])
  merged.mcpTrustedProjectServers = coerceStringArrayMap(s['mcpTrustedProjectServers'])
  merged.mcpUntrustedGlobalServers = coerceStringArray(s['mcpUntrustedGlobalServers'])
  merged.mcpSpawnConsented = coerceStringArray(s['mcpSpawnConsented'])
  merged.githubClientId = typeof s['githubClientId'] === 'string' ? s['githubClientId'] : ''
  merged.skillsDisabledGlobal = coerceStringArray(s['skillsDisabledGlobal'])
  merged.skillsDisabledProject = coerceStringArrayMap(s['skillsDisabledProject'])
  // Plugins (Phase G plugins arc): same string[] coercion guarantee as
  // mcpEnabledServers/skillsDisabledGlobal above. Optional & additive.
  merged.pluginsEnabled = coerceStringArray(s['pluginsEnabled'])
  merged.marketplaces = coerceStringArray(s['marketplaces'])
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
  if (patch.defaultEffort !== undefined && !isEffortLevel(patch.defaultEffort)) {
    throw new Error(`Invalid defaultEffort: ${String(patch.defaultEffort)}`)
  }
  // Appearance write-validation: reject unknown enum values and malformed custom
  // colors at the boundary (never persist a value the apply module can't read).
  if (patch.theme !== undefined && !isThemeMode(patch.theme)) {
    throw new Error(`Invalid theme: ${String(patch.theme)}`)
  }
  if (patch.fontSize !== undefined && !isFontSize(patch.fontSize)) {
    throw new Error(`Invalid fontSize: ${String(patch.fontSize)}`)
  }
  if (patch.conversationWidth !== undefined && !isConversationWidth(patch.conversationWidth)) {
    throw new Error(`Invalid conversationWidth: ${String(patch.conversationWidth)}`)
  }
  if (patch.chatFont !== undefined && !isChatFont(patch.chatFont)) {
    throw new Error(`Invalid chatFont: ${String(patch.chatFont)}`)
  }
  if (patch.customColors !== undefined) {
    patch = { ...patch, customColors: coerceCustomColors(patch.customColors) }
  }
  // Never persist malformed pricing: coerce the patch before write so a bad
  // Sync payload drops non-numeric/negative entries instead of poisoning cost.
  if (patch.modelPricing !== undefined) {
    patch = { ...patch, modelPricing: coercePricing(patch.modelPricing) }
  }
  // Reject an unknown STT backend at the boundary (never persist a value the
  // transcribe router can't dispatch on).
  if (patch.sttBackend !== undefined && !isSttBackend(patch.sttBackend)) {
    throw new Error(`Invalid sttBackend: ${String(patch.sttBackend)}`)
  }
  // Never persist a malformed model-management payload: coerce the patch before
  // write so a bad Add-model entry drops instead of poisoning the registry.
  if (patch.customModels !== undefined) {
    patch = { ...patch, customModels: coerceCustomModels(patch.customModels) }
  }
  if (patch.disabledModels !== undefined) {
    patch = { ...patch, disabledModels: coerceStringArray(patch.disabledModels) }
  }
  // F8 Agent Settings: reject an unknown enum at the boundary so a bad value
  // (never a loosened one) can't be persisted.
  if (patch.securityPreset !== undefined && !isSecurityPreset(patch.securityPreset)) {
    throw new Error(`Invalid securityPreset: ${String(patch.securityPreset)}`)
  }
  if (patch.fileAccessPolicy !== undefined && !isFileAccessPolicy(patch.fileAccessPolicy)) {
    throw new Error(`Invalid fileAccessPolicy: ${String(patch.fileAccessPolicy)}`)
  }
  if (patch.terminalAutoExec !== undefined && !isTerminalAutoExec(patch.terminalAutoExec)) {
    throw new Error(`Invalid terminalAutoExec: ${String(patch.terminalAutoExec)}`)
  }
  // F9: coerce the new-project template on write so a malformed field can never
  // persist (drops unknown/invalid keys rather than throwing at the boundary).
  if (patch.newProjectDefaults !== undefined) {
    patch = { ...patch, newProjectDefaults: coerceProjectSettings(patch.newProjectDefaults) }
  }
  // F4 browser tool: never persist a non-boolean enable flag or a malformed
  // domain list -- coerce the patch before write, same pattern as disabledModels.
  if (patch.browserEnabled !== undefined) {
    patch = { ...patch, browserEnabled: patch.browserEnabled === true }
  }
  if (patch.browserAllowlist !== undefined) {
    patch = { ...patch, browserAllowlist: coerceStringArray(patch.browserAllowlist) }
  }
  if (patch.browserBlocklist !== undefined) {
    patch = { ...patch, browserBlocklist: coerceStringArray(patch.browserBlocklist) }
  }
  // Connectors/MCP: same coercion guarantee as the browser flags above.
  if (patch.mcpEnabled !== undefined) {
    patch = { ...patch, mcpEnabled: patch.mcpEnabled === true }
  }
  if (patch.mcpEnabledServers !== undefined) {
    patch = { ...patch, mcpEnabledServers: coerceStringArray(patch.mcpEnabledServers) }
  }
  if (patch.mcpTrustedProjectServers !== undefined) {
    patch = {
      ...patch,
      mcpTrustedProjectServers: coerceStringArrayMap(patch.mcpTrustedProjectServers)
    }
  }
  if (patch.mcpUntrustedGlobalServers !== undefined) {
    patch = {
      ...patch,
      mcpUntrustedGlobalServers: coerceStringArray(patch.mcpUntrustedGlobalServers)
    }
  }
  if (patch.mcpSpawnConsented !== undefined) {
    patch = { ...patch, mcpSpawnConsented: coerceStringArray(patch.mcpSpawnConsented) }
  }
  if (patch.githubClientId !== undefined) {
    patch = {
      ...patch,
      githubClientId: typeof patch.githubClientId === 'string' ? patch.githubClientId : ''
    }
  }
  if (patch.skillsDisabledGlobal !== undefined) {
    patch = { ...patch, skillsDisabledGlobal: coerceStringArray(patch.skillsDisabledGlobal) }
  }
  if (patch.skillsDisabledProject !== undefined) {
    patch = { ...patch, skillsDisabledProject: coerceStringArrayMap(patch.skillsDisabledProject) }
  }
  // Plugins: same coercion guarantee as skillsDisabledGlobal/mcpEnabledServers.
  if (patch.pluginsEnabled !== undefined) {
    patch = { ...patch, pluginsEnabled: coerceStringArray(patch.pluginsEnabled) }
  }
  if (patch.marketplaces !== undefined) {
    patch = { ...patch, marketplaces: coerceStringArray(patch.marketplaces) }
  }
  const next = { ...getSettings(), ...patch }
  cache = next
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}

export function settingsInfo(): SettingsInfo {
  return { ...getSettings(), dataPath: app.getPath('userData') }
}
