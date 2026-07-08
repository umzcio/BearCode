// F9 — the pure inheritance rule for a new conversation's starting defaults:
// a project's per-project override wins; any field the project leaves unset
// falls back to the global default; no project → all global. No side effects
// (unit-tested), so the store and any future main-side seeding share one truth.
import type { AppSettings, EffortLevel, ModelRef, PermissionMode } from './types'

export interface ResolvedDefaults {
  modelRef: ModelRef | null
  effort: EffortLevel
  permissionMode: PermissionMode
}

type GlobalDefaults = Pick<
  AppSettings,
  'defaultModelRef' | 'defaultEffort' | 'defaultPermissionMode'
>

// Structural source of per-project overrides — satisfied by both the retired E4
// `Project` and the folder=project `FolderProject`, so the resolver is agnostic
// to which entity supplies the defaults.
type ProjectDefaultSource = {
  defaultModelRef?: ModelRef | null
  defaultEffort?: EffortLevel | null
  defaultPermissionMode?: PermissionMode | null
}

export function resolveProjectDefaults(
  project: ProjectDefaultSource | null,
  global: GlobalDefaults
): ResolvedDefaults {
  return {
    modelRef: project?.defaultModelRef ?? global.defaultModelRef ?? null,
    // effort/permissionMode always have a concrete global default in AppSettings;
    // the project override wins only when set.
    effort: project?.defaultEffort ?? global.defaultEffort,
    permissionMode: project?.defaultPermissionMode ?? global.defaultPermissionMode
  }
}
