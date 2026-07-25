# Agent Config Import — Plan B: MCP Server Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect MCP server definitions from `.claude/settings.json`, `.cursor/mcp.json`, and `.windsurf/mcp.json`, and surface them in the same Review & Import modal Plan A built (PR #20), as a fourth "Import as Connector" bucket alongside Rules/Workflows/Skills.

**Architecture:** Extend `discoverLocalServers` (already powers the Connectors page's "Import local…" picker) with three more source reads — the existing picker gains them for free. A new adapter (`configImport/mcpCandidates.ts`) maps discovered servers into the same `ImportCandidate` shape the modal renders. The existing `bearcode:mcp:import` IPC handler's persistence logic gets extracted into a reusable function so both the standalone Connectors flow and the new unified importer call the identical code path — no forked logic. MCP entries reuse the `imported_config_sources` table Plan A built, so banner dismiss/re-remind works uniformly across all four kinds; "Check for updates" is explicitly not built for MCP (same treatment Skills already get).

**Tech Stack:** Electron main process (Node fs), React 19 renderer, vitest.

**IMPORTANT — branch base:** This plan depends entirely on Plan A's code (`configImport/*`, `ImportConfigReviewModal.tsx`, the `imported_config_sources` table, etc.), which exists only on the `worktree-agent-config-import` branch (PR #20, not yet merged to `main` as of this writing). Implementation must branch from `worktree-agent-config-import`, not `main`. If PR #20 has merged to `main` by the time this plan executes, branch from `main` instead and skip the branch-base note below.

## Global Constraints

- Pure Node builtins only in `src/main/mcp/` and `src/main/configImport/` — no new npm dependencies.
- Never throw: malformed/missing config files degrade to being skipped, matching `discoverLocalServers`'s existing `readServerMap` contract (capped read + JSON.parse try/catch, never throws).
- Reads capped at 64KB via the existing `readFileCapped`/`readServerMap` (`MAX_MCP_JSON_BYTES` in `src/main/mcp/store.ts`).
- Imported servers land in the same untrusted/disabled-by-default state as any other import — no new trust concept, no auto-enable, no auto-spawn. Secrets are never copied (header/env values blanked).
- Hooks detection is explicitly out of scope for this plan.
- "Check for updates" for MCP servers is explicitly out of scope for this plan.
- Vitest gate: `npx vitest run`. Typecheck gate: `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`. Baseline (as of PR #20, unmerged): 16 node-tc / 2 web-tc errors — anything above that is a regression.
- Auto-fix scope: `npx eslint --fix <specific paths>` only, never the bare `lint` script. Note: `npx eslint` currently crashes repo-wide in this worktree on an unrelated dependency-loading error (`@electron-toolkit/eslint-config-ts`) — this is pre-existing and not fixable within this plan; rely on tsc + hand review instead.

---

### Task 1: Extend shared types

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/configImport/types.ts`
- Modify: `src/main/db/index.ts`
- Modify: `src/main/configImport/checkUpdates.ts`
- Test: `src/main/configImport/checkUpdates.test.ts`

**Interfaces:**
- Produces: `DiscoveredMcpServer['origin']` extended to `'claude-desktop' | 'project-mcp-json' | 'claude-settings-json' | 'cursor-mcp-json' | 'windsurf-mcp-json'`; `ImportKind` extended to `'rule' | 'workflow' | 'skill' | 'unsupported' | 'mcp'`; `ImportSelection` gains `mcpServers: string[]`; `ImportSummary` gains `mcpServersImported: number`; `ImportedConfigRow['importedAsType']` extended to `'rule' | 'workflow' | 'skill' | 'mcp' | null`.

- [ ] **Step 1: Extend `src/shared/types.ts`**

Find and update these three declarations (currently at ~lines 403-412, 1324, 1350-1359):

```typescript
export interface DiscoveredMcpServer {
  name: string
  origin:
    | 'claude-desktop'
    | 'project-mcp-json'
    | 'claude-settings-json'
    | 'cursor-mcp-json'
    | 'windsurf-mcp-json'
  transport: McpTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}
```

```typescript
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported' | 'mcp'
```

```typescript
export interface ImportSelection {
  rules: string[]
  workflows: string[]
  skills: string[]
  mcpServers: string[]
}
export interface ImportSummary {
  rulesImported: number
  workflowsImported: number
  skillsImported: number
  mcpServersImported: number
}
```

- [ ] **Step 2: Extend `src/main/configImport/types.ts`**

Update the `ImportKind` line (currently line 2) to match Step 1 exactly:

```typescript
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported' | 'mcp'
```

- [ ] **Step 3: Extend `ImportedConfigRow` in `src/main/db/index.ts`**

Find `importedAsType: 'rule' | 'workflow' | 'skill' | null` (currently line 1204) and change to:

```typescript
  importedAsType: 'rule' | 'workflow' | 'skill' | 'mcp' | null
```

- [ ] **Step 4: Write the failing test for `importedDirFor`'s exhaustiveness**

`src/main/configImport/checkUpdates.ts`'s `importedDirFor` function is a `switch` over `ImportedConfigRow['importedAsType']` (minus `null`) that TypeScript's `noImplicitReturns` makes exhaustive — extending the type in Step 3 will make it fail to compile until a `'mcp'` case is added. Add a behavioral test first:

```typescript
// Add to src/main/configImport/checkUpdates.test.ts, inside the existing describe block
// or a new one — follow the file's existing test setup (applyImportSelection-based
// fixture in beforeEach) for how to construct a real imported-config row if needed.
it('candidateBody returns null for an mcp-tracked row (out of scope, no throw)', () => {
  // An MCP-tracked row's sourcePath is a synthetic key, not a real file path on
  // disk, and never matches anything scanImportableConfig() finds — so
  // checkSourceForUpdate must degrade gracefully, not throw, when called on one.
  const dir = mkdtempSync(join(tmpdir(), 'bearcode-mcp-checkupdate-'))
  upsertImportedConfig(dir, '.claude/settings.json#filesystem', {
    importedAsType: 'mcp',
    importedAsName: 'filesystem',
    status: 'imported',
    createdAt: Date.now()
  })
  expect(() => checkSourceForUpdate(dir, '.claude/settings.json#filesystem')).not.toThrow()
  rmSync(dir, { recursive: true, force: true })
})
```

Adjust imports (`mkdtempSync`, `tmpdir`, `join`, `rmSync`, `upsertImportedConfig`, `checkSourceForUpdate`) to match whatever this test file already imports — read the file first to avoid duplicate imports.

- [ ] **Step 5: Run test to verify tsc fails first (the real RED here is a compile error)**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: FAIL — `checkUpdates.ts`'s `importedDirFor` switch is no longer exhaustive (TS7030 or similar "not all code paths return a value").

- [ ] **Step 6: Add the `'mcp'` case to `importedDirFor`**

In `src/main/configImport/checkUpdates.ts`, update the switch (currently ~lines 32-41):

```typescript
  switch (type) {
    case 'rule':
      return join(projectPath, '.agents', 'rules')
    case 'workflow':
      return join(projectPath, '.agents', 'workflows')
    case 'skill':
      // Skills are folders, not a single .md body -- diffed/updated as whole
      // directories, which the text-diff update flow does not handle.
      return null
    case 'mcp':
      // MCP servers are import-once in this plan (Global Constraints) --
      // "Check for updates" is not built for them, matching Skills above.
      return null
  }
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx tsc --noEmit -p tsconfig.node.json` (expect no new errors beyond baseline)
Run: `npx vitest run src/main/configImport/checkUpdates.test.ts` (expect the new test to pass, plus all existing ones)

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/configImport/types.ts src/main/db/index.ts src/main/configImport/checkUpdates.ts src/main/configImport/checkUpdates.test.ts
git commit -m "feat(config-import): extend shared types for MCP server import"
```

---

### Task 2: Extend `discoverLocalServers` + extract `importDiscoveredServers`

**Files:**
- Modify: `src/main/mcp/store.ts`
- Modify: `src/main/ipc.ts`
- Test: `src/main/mcp/discover.test.ts`
- Test: `src/main/mcp/store.test.ts`

**Interfaces:**
- Consumes: `DiscoveredMcpServer` (Task 1), existing `readServerMap`/`classifyTransport`/`toDiscovered`/`invalidateStaleConsentOnImport`/`upsertServer` in the same file
- Produces: `discoverLocalServers(projectPath: string | null): DiscoveredMcpServer[]` (extended with 3 more sources), `importDiscoveredServers(servers: DiscoveredMcpServer[], projectPath: string | null): McpServerConfig[]` (new export)

- [ ] **Step 1: Write the failing tests for the 3 new discovery sources**

```typescript
// Add to src/main/mcp/discover.test.ts — follow the file's existing fs/os mock
// idiom (read the file first; it already mocks 'fs'/'os' in-memory for this
// exact function). These three tests mirror the existing 'project-mcp-json'
// coverage in the same file, just for the three new source files.
it('discovers servers from .claude/settings.json\'s mcpServers key', () => {
  writeFile(
    join('/fake/project', '.claude', 'settings.json'),
    JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'mcp-fs'] } } })
  )
  const found = discoverLocalServers('/fake/project')
  expect(found).toContainEqual(
    expect.objectContaining({ name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio' })
  )
})

it('discovers servers from .cursor/mcp.json', () => {
  writeFile(
    join('/fake/project', '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { github: { url: 'https://example.com/mcp' } } })
  )
  const found = discoverLocalServers('/fake/project')
  expect(found).toContainEqual(
    expect.objectContaining({ name: 'github', origin: 'cursor-mcp-json', transport: 'http' })
  )
})

it('discovers servers from .windsurf/mcp.json', () => {
  writeFile(
    join('/fake/project', '.windsurf', 'mcp.json'),
    JSON.stringify({ mcpServers: { search: { url: 'https://example.com/search' } } })
  )
  const found = discoverLocalServers('/fake/project')
  expect(found).toContainEqual(
    expect.objectContaining({ name: 'search', origin: 'windsurf-mcp-json', transport: 'http' })
  )
})

it('degrades to empty on malformed JSON in any of the three new files, never throws', () => {
  writeFile(join('/fake/project', '.claude', 'settings.json'), 'not json{{{')
  expect(() => discoverLocalServers('/fake/project')).not.toThrow()
  expect(discoverLocalServers('/fake/project')).toEqual([])
})
```

Adapt `writeFile`/path-joining to whatever helper the existing in-memory fs mock in this file actually provides — read `discover.test.ts` in full first; do not invent a different mocking mechanism.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/mcp/discover.test.ts`
Expected: FAIL — `.claude/settings.json`, `.cursor/mcp.json`, `.windsurf/mcp.json` are not yet read by `discoverLocalServers`.

- [ ] **Step 3: Extend `discoverLocalServers` in `src/main/mcp/store.ts`**

Add three new path helpers near the existing `claudeDesktopConfigPath`/`projectDotMcpJsonPath` (~lines 179-188):

```typescript
function claudeSettingsJsonPath(projectPath: string): string {
  return join(projectPath, '.claude', 'settings.json')
}

function cursorMcpJsonPath(projectPath: string): string {
  return join(projectPath, '.cursor', 'mcp.json')
}

function windsurfMcpJsonPath(projectPath: string): string {
  return join(projectPath, '.windsurf', 'mcp.json')
}
```

Update `discoverLocalServers` (currently ~lines 214-227):

```typescript
export function discoverLocalServers(projectPath: string | null): DiscoveredMcpServer[] {
  const byName = new Map<string, DiscoveredMcpServer>()
  const desktopRaw = readServerMap(claudeDesktopConfigPath())
  for (const [name, entry] of Object.entries(desktopRaw)) {
    byName.set(name, toDiscovered(name, entry, 'claude-desktop'))
  }
  if (projectPath) {
    const projectRaw = readServerMap(projectDotMcpJsonPath(projectPath))
    for (const [name, entry] of Object.entries(projectRaw)) {
      byName.set(name, toDiscovered(name, entry, 'project-mcp-json'))
    }
    const claudeSettingsRaw = readServerMap(claudeSettingsJsonPath(projectPath))
    for (const [name, entry] of Object.entries(claudeSettingsRaw)) {
      byName.set(name, toDiscovered(name, entry, 'claude-settings-json'))
    }
    const cursorRaw = readServerMap(cursorMcpJsonPath(projectPath))
    for (const [name, entry] of Object.entries(cursorRaw)) {
      byName.set(name, toDiscovered(name, entry, 'cursor-mcp-json'))
    }
    const windsurfRaw = readServerMap(windsurfMcpJsonPath(projectPath))
    for (const [name, entry] of Object.entries(windsurfRaw)) {
      byName.set(name, toDiscovered(name, entry, 'windsurf-mcp-json'))
    }
  }
  return Array.from(byName.values())
}
```

(Later-set origins win on a same-named collision, same precedence rule as the existing two sources — this is an accepted, documented behavior already implied by the original function's `Map.set` merge, not a new decision.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/mcp/discover.test.ts`
Expected: PASS (all tests, including pre-existing ones)

- [ ] **Step 5: Write the failing test for `importDiscoveredServers`**

Read `src/main/mcp/store.test.ts` first to see its existing mocking setup for `getSettings`/`setSettings` and any existing `invalidateStaleConsentOnImport` tests — reuse that exact pattern.

```typescript
// Add to src/main/mcp/store.test.ts
describe('importDiscoveredServers', () => {
  it('persists a valid stdio and a valid http server', () => {
    const servers: DiscoveredMcpServer[] = [
      { name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] },
      { name: 'github', origin: 'cursor-mcp-json', transport: 'http', url: 'https://example.com/mcp' }
    ]
    const imported = importDiscoveredServers(servers, '/fake/project')
    expect(imported).toHaveLength(2)
    expect(imported.map((c) => c.name)).toEqual(['filesystem', 'github'])
  })

  it('scopes any non-claude-desktop origin to project when a projectPath is given', () => {
    const servers: DiscoveredMcpServer[] = [
      { name: 'x', origin: 'windsurf-mcp-json', transport: 'http', url: 'https://x' }
    ]
    const imported = importDiscoveredServers(servers, '/fake/project')
    expect(imported[0].source).toBe('project')
  })

  it('scopes claude-desktop origin to global even with a projectPath given', () => {
    const servers: DiscoveredMcpServer[] = [
      { name: 'y', origin: 'claude-desktop', transport: 'http', url: 'https://y' }
    ]
    const imported = importDiscoveredServers(servers, '/fake/project')
    expect(imported[0].source).toBe('global')
  })

  it('skips an entry with no name or an invalid transport', () => {
    const servers = [
      { name: '', origin: 'claude-settings-json', transport: 'http', url: 'https://x' },
      { name: 'bad', origin: 'claude-settings-json', transport: 'websocket', url: 'https://x' }
    ] as DiscoveredMcpServer[]
    expect(importDiscoveredServers(servers, '/fake/project')).toEqual([])
  })

  it('blanks header/env values so no plaintext secret is ever persisted', () => {
    const servers: DiscoveredMcpServer[] = [
      {
        name: 'secure',
        origin: 'claude-settings-json',
        transport: 'http',
        url: 'https://x',
        headers: { Authorization: 'Bearer real-secret-value' }
      }
    ]
    const imported = importDiscoveredServers(servers, '/fake/project')
    expect(imported[0].headers?.Authorization).toBe('')
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/main/mcp/store.test.ts`
Expected: FAIL — `importDiscoveredServers` is not exported from `./store`.

- [ ] **Step 7: Extract `importDiscoveredServers` in `src/main/mcp/store.ts`**

Add near `invalidateStaleConsentOnImport` (end of file):

```typescript
// Persists a batch of discovered servers through the same upsertServer path
// as manual add / Smithery install -- never a side path. Secrets are NEVER
// auto-copied from a foreign config: header/env VALUES are blanked (keys
// kept) so the user must fill each one in via mcp.setSecret before the
// server can authenticate. Shared by the standalone Connectors "Import
// local…" flow (bearcode:mcp:import) and the unified config-import flow
// (configImport/importer.ts) so there is exactly one persistence path, not
// two forks of the same logic.
export function importDiscoveredServers(
  servers: DiscoveredMcpServer[],
  projectPath: string | null
): McpServerConfig[] {
  const blankValues = (o?: Record<string, string>): Record<string, string> | undefined =>
    o ? Object.fromEntries(Object.keys(o).map((k) => [k, ''])) : undefined
  const imported: McpServerConfig[] = []
  for (const raw of servers) {
    if (raw == null || typeof raw !== 'object') continue
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) continue
    if (raw.transport !== 'http' && raw.transport !== 'stdio') continue
    const name = raw.name.trim()
    // Only a machine-level Claude Desktop config stays global; every
    // project-file-sourced origin (the legacy .mcp.json plus the three new
    // ones from Task 1) scopes to the open project, same as .mcp.json always
    // has.
    const source: 'global' | 'project' = raw.origin !== 'claude-desktop' && projectPath ? 'project' : 'global'
    const cfg: McpServerConfig = {
      name,
      transport: raw.transport,
      source,
      url: raw.url,
      headers: blankValues(raw.headers),
      command: raw.command,
      args: raw.args,
      env: blankValues(raw.env)
    }
    invalidateStaleConsentOnImport(cfg, projectPath)
    upsertServer(cfg, projectPath)
    imported.push(cfg)
  }
  return imported
}
```

- [ ] **Step 8: Update the existing `bearcode:mcp:import` IPC handler to delegate**

In `src/main/ipc.ts`, find the `bearcode:mcp:import` handler (~lines 1138-1174) and replace its body to call the extracted function, keeping the existing shape-validation and the `McpServerView` mapping (which needs the closure-local `mcpServerView` helper, so it stays in `ipc.ts`):

```typescript
  ipcMain.handle('bearcode:mcp:import', (_e, servers: unknown, projectPath: unknown) => {
    if (!Array.isArray(servers)) {
      throw new Error(`Invalid discovered servers: ${String(servers)}`)
    }
    const proj = asProjectPath(projectPath)
    const validated = (servers as unknown[]).filter(
      (raw): raw is DiscoveredMcpServer =>
        raw != null && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
    )
    const imported = importDiscoveredServers(validated, proj)
    return imported.map((cfg) => mcpServerView(cfg, proj))
  })
```

Add `importDiscoveredServers` to the existing `from './mcp/store'` import list near the top of `ipc.ts` (alongside `discoverLocalServers`, `upsertServer as upsertMcpServer`, etc.).

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run src/main/mcp/store.test.ts src/main/mcp/discover.test.ts`
Expected: PASS (all tests)

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no new errors beyond baseline

- [ ] **Step 10: Run the full suite once**

Run: `npx vitest run`
Expected: PASS, no regressions (the Connectors page's existing manual-import flow must behave identically — it now calls the same function it always effectively did, just factored out)

- [ ] **Step 11: Commit**

```bash
git add src/main/mcp/store.ts src/main/mcp/discover.test.ts src/main/mcp/store.test.ts src/main/ipc.ts
git commit -m "feat(config-import): detect MCP servers in .claude/settings.json, .cursor/mcp.json, .windsurf/mcp.json"
```

---

### Task 3: MCP candidate adapter

**Files:**
- Create: `src/main/configImport/mcpCandidates.ts`
- Test: `src/main/configImport/mcpCandidates.test.ts`

**Interfaces:**
- Consumes: `discoverLocalServers` (Task 2, `../mcp/store`), `ImportCandidate`/`ImportTool` (`./types`), `DiscoveredMcpServer` (`../../shared/types`)
- Produces: `mcpSourcePathFor(server: DiscoveredMcpServer): string | null` (exported for reuse by the importer in Task 4), `buildMcpCandidates(projectPath: string): ImportCandidate[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/mcpCandidates.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildMcpCandidates, mcpSourcePathFor } from './mcpCandidates'
import * as mcpStore from '../mcp/store'
import type { DiscoveredMcpServer } from '../../shared/types'

describe('mcpSourcePathFor', () => {
  it('builds a synthetic per-server source path keyed by origin file + server name', () => {
    const s: DiscoveredMcpServer = {
      name: 'filesystem',
      origin: 'claude-settings-json',
      transport: 'stdio',
      command: 'npx'
    }
    expect(mcpSourcePathFor(s)).toBe('.claude/settings.json#filesystem')
  })

  it('maps each project-scoped origin to its own file prefix', () => {
    expect(
      mcpSourcePathFor({ name: 'a', origin: 'project-mcp-json', transport: 'http', url: 'https://a' })
    ).toBe('.mcp.json#a')
    expect(
      mcpSourcePathFor({ name: 'b', origin: 'cursor-mcp-json', transport: 'http', url: 'https://b' })
    ).toBe('.cursor/mcp.json#b')
    expect(
      mcpSourcePathFor({ name: 'c', origin: 'windsurf-mcp-json', transport: 'http', url: 'https://c' })
    ).toBe('.windsurf/mcp.json#c')
  })

  it('returns null for claude-desktop origin (not a project-relative source)', () => {
    expect(
      mcpSourcePathFor({ name: 'd', origin: 'claude-desktop', transport: 'http', url: 'https://d' })
    ).toBeNull()
  })
})

describe('buildMcpCandidates', () => {
  it('maps a discovered project-scoped server into an ImportCandidate', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates).toEqual([
      {
        sourcePath: '.claude/settings.json#filesystem',
        kind: 'mcp',
        tool: 'claude-code',
        buildable: true,
        preview: 'local · npx -y mcp-fs'
      }
    ])
  })

  it('excludes claude-desktop-origin servers (machine-level, not project-detected)', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'x', origin: 'claude-desktop', transport: 'http', url: 'https://x' }
    ])
    expect(buildMcpCandidates('/fake/project')).toEqual([])
  })

  it('maps cursor-mcp-json and windsurf-mcp-json origins to their respective tools', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'a', origin: 'cursor-mcp-json', transport: 'http', url: 'https://a' },
      { name: 'b', origin: 'windsurf-mcp-json', transport: 'http', url: 'https://b' }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates.find((c) => c.sourcePath.includes('cursor'))?.tool).toBe('cursor')
    expect(candidates.find((c) => c.sourcePath.includes('windsurf'))?.tool).toBe('windsurf')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/mcpCandidates.test.ts`
Expected: FAIL — cannot find module `./mcpCandidates`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/mcpCandidates.ts
import { discoverLocalServers } from '../mcp/store'
import type { DiscoveredMcpServer } from '../../shared/types'
import type { ImportCandidate, ImportTool } from './types'

const ORIGIN_PREFIX: Partial<Record<DiscoveredMcpServer['origin'], string>> = {
  'project-mcp-json': '.mcp.json',
  'claude-settings-json': '.claude/settings.json',
  'cursor-mcp-json': '.cursor/mcp.json',
  'windsurf-mcp-json': '.windsurf/mcp.json'
}

const ORIGIN_TOOL: Partial<Record<DiscoveredMcpServer['origin'], ImportTool>> = {
  'project-mcp-json': 'claude-code',
  'claude-settings-json': 'claude-code',
  'cursor-mcp-json': 'cursor',
  'windsurf-mcp-json': 'windsurf'
}

// A synthetic per-server tracking key: one file can define several servers,
// and imported_config_sources is keyed on (projectPath, sourcePath), so the
// key must be per-server, not per-file. Returns null for 'claude-desktop' --
// that's a machine-level config, not something detected IN this project, so
// it has no project-relative path to synthesize and is excluded from the
// unified modal entirely (buildMcpCandidates filters it out below).
export function mcpSourcePathFor(server: DiscoveredMcpServer): string | null {
  const prefix = ORIGIN_PREFIX[server.origin]
  return prefix ? `${prefix}#${server.name}` : null
}

// Unlike rules/workflows/skills, a discovered MCP server is already valid
// parsed JSON -- there is no translation step that can fail the way a rule
// file's frontmatter can, so every mapped candidate is buildable: true.
export function buildMcpCandidates(projectPath: string): ImportCandidate[] {
  const discovered = discoverLocalServers(projectPath)
  const candidates: ImportCandidate[] = []
  for (const server of discovered) {
    const sourcePath = mcpSourcePathFor(server)
    const tool = ORIGIN_TOOL[server.origin]
    if (sourcePath === null || tool === undefined) continue
    const preview =
      server.transport === 'stdio'
        ? `local · ${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`
        : `remote · ${server.url ?? ''}`
    candidates.push({ sourcePath, kind: 'mcp', tool, buildable: true, preview })
  }
  return candidates
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/mcpCandidates.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/mcpCandidates.ts src/main/configImport/mcpCandidates.test.ts
git commit -m "feat(config-import): map discovered MCP servers into the shared candidate view"
```

---

### Task 4: Wire MCP into scan + apply

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/configImport/importer.ts`
- Test: `src/main/configImport/importer.test.ts`

**Interfaces:**
- Consumes: `buildMcpCandidates`, `mcpSourcePathFor` (Task 3), `importDiscoveredServers` (Task 2), `discoverLocalServers` (Task 2), `ImportSelection`/`ImportSummary` (extended, Task 1)
- Produces: `applyImportSelection` now handles `selection.mcpServers`; `bearcode:config-import:scan` now returns MCP candidates merged in

- [ ] **Step 1: Write the failing test for `applyImportSelection`'s MCP handling**

```typescript
// Add to src/main/configImport/importer.test.ts
import { readFileSync } from 'fs'
import { getImportedConfig } from '../db'

describe('applyImportSelection — MCP servers', () => {
  it('imports a selected MCP server, persists it to the registry, and records a tracking row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bearcode-importer-mcp-'))
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'mcp-fs'] } } })
    )
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [],
      skills: [],
      mcpServers: ['.claude/settings.json#filesystem']
    })
    expect(summary.mcpServersImported).toBe(1)
    // Confirm it actually landed in BearCode's own registry
    // (<project>/.agents/mcp.json) -- NOT just that the untouched source file
    // still reports it, which would prove nothing about the import itself.
    const registry = JSON.parse(readFileSync(join(dir, '.agents', 'mcp.json'), 'utf8'))
    expect(registry.mcpServers.filesystem).toMatchObject({ command: 'npx', args: ['-y', 'mcp-fs'] })
    const row = getImportedConfig(dir, '.claude/settings.json#filesystem')
    expect(row).toMatchObject({ importedAsType: 'mcp', importedAsName: 'filesystem', status: 'imported' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips a selected MCP sourcePath that no longer resolves to a discovered server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bearcode-importer-mcp-gone-'))
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [],
      skills: [],
      mcpServers: ['.claude/settings.json#gone']
    })
    expect(summary.mcpServersImported).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
```

Adjust imports to match the test file's existing style (it already imports `mkdtempSync`/`writeFileSync`/`mkdirSync`/`rmSync`/`join`/`tmpdir` — read the file first to avoid duplicate imports).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/importer.test.ts`
Expected: FAIL — `ImportSelection` has no `mcpServers` field yet accepted by `applyImportSelection` (tsc error) / `summary.mcpServersImported` is `undefined`.

- [ ] **Step 3: Extend `applyImportSelection` in `src/main/configImport/importer.ts`**

Add the import at the top:

```typescript
import { discoverLocalServers, importDiscoveredServers } from '../mcp/store'
import { mcpSourcePathFor } from './mcpCandidates'
```

Update `ImportSummary`'s initial value and add a new loop at the end of `applyImportSelection`, before `return summary`:

```typescript
  const summary: ImportSummary = {
    rulesImported: 0,
    workflowsImported: 0,
    skillsImported: 0,
    mcpServersImported: 0
  }
```

```typescript
  const discoveredServers = discoverLocalServers(projectPath)
  const byMcpSourcePath = new Map(
    discoveredServers
      .map((s) => [mcpSourcePathFor(s), s] as const)
      .filter((entry): entry is [string, (typeof discoveredServers)[number]] => entry[0] !== null)
  )
  const selectedServers = uniq(selection.mcpServers)
    .map((sourcePath) => byMcpSourcePath.get(sourcePath))
    .filter((s): s is (typeof discoveredServers)[number] => s !== undefined)
  if (selectedServers.length > 0) {
    const imported = importDiscoveredServers(selectedServers, projectPath)
    // Match each recorded row back to ITS OWN selectedServers entry (not a
    // by-name lookup into `imported`) so two selected servers that happen to
    // share a `name` (e.g. one from .cursor/mcp.json, one from
    // .windsurf/mcp.json) can never cross-attribute a sourcePath.
    const importedNames = new Set(imported.map((cfg) => cfg.name))
    for (const server of selectedServers) {
      if (!importedNames.has(server.name)) continue
      const sourcePath = mcpSourcePathFor(server)
      if (sourcePath === null) continue
      upsertImportedConfig(projectPath, sourcePath, {
        sourceHash: null,
        importedAsType: 'mcp',
        importedAsName: server.name,
        status: 'imported',
        createdAt: Date.now()
      })
    }
    summary.mcpServersImported = imported.length
  }
```

(`sourceHash: null` — Global Constraints: MCP entries don't support "check for updates" in this plan, so there is nothing meaningful to hash; `getImportedConfig`/`ImportedConfigRow.sourceHash` already accepts `null`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/importer.test.ts`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Wire MCP candidates into the scan handler**

In `src/main/ipc.ts`, find the `bearcode:config-import:scan` handler (~lines 1203-1231) and add MCP candidates to the merged list. Update the import line near the top to add `buildMcpCandidates` alongside the existing `buildCandidateViews` import (`from './configImport/candidateViews'` stays separate; add a new import `import { buildMcpCandidates } from './configImport/mcpCandidates'`), then update the handler body:

```typescript
  ipcMain.handle('bearcode:config-import:scan', (_e, p: unknown) => {
    const projectPath = reqPath(p)
    const detected = scanImportableConfig(projectPath)
    const known = db.listImportedConfig(projectPath)
    const importedPaths = new Set(known.filter((k) => k.status === 'imported').map((k) => k.sourcePath))
    const remaining = detected.filter((d) => !importedPaths.has(d.sourcePath))
    const ruleCandidates = buildCandidateViews(projectPath, remaining, db.getOutsidePolicy(projectPath))
    const mcpCandidates = buildMcpCandidates(projectPath).filter((c) => !importedPaths.has(c.sourcePath))
    const candidates = [...ruleCandidates, ...mcpCandidates]
    const showBanner = shouldShowImportBanner(
      candidates.filter((c) => c.buildable),
      known,
      Date.now()
    )
    return { candidates, showBanner }
  })
```

Update `assertValidImportSelection` (~lines 1193-1201) to also validate `mcpServers`:

```typescript
  function assertValidImportSelection(raw: unknown): ImportSelection {
    if (raw == null || typeof raw !== 'object') throw new Error('Invalid import selection.')
    const r = raw as Partial<Record<keyof ImportSelection, unknown>>
    return {
      rules: asStringArray(r.rules, 'import selection rules'),
      workflows: asStringArray(r.workflows, 'import selection workflows'),
      skills: asStringArray(r.skills, 'import selection skills'),
      mcpServers: asStringArray(r.mcpServers, 'import selection mcp servers')
    }
  }
```

- [ ] **Step 6: Run the full suite and both tsc gates**

Run: `npx vitest run`
Expected: PASS, no regressions

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no new errors beyond baseline

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts src/main/configImport/importer.ts src/main/configImport/importer.test.ts
git commit -m "feat(config-import): wire MCP candidates into scan + apply"
```

---

### Task 5: Renderer — modal bucket, Connectors label, toast

**Files:**
- Modify: `src/renderer/src/components/ImportConfigReviewModal.tsx`
- Modify: `src/renderer/src/components/Settings/pages/ConnectorsPage.tsx`
- Modify: `src/renderer/src/state/store.ts`

**Interfaces:**
- Consumes: `ImportCandidate`/`ImportSelection`/`ImportSummary` (extended, Task 1), `DiscoveredMcpServer` (extended, Task 1)

- [ ] **Step 1: Extend `KIND_LABEL` and selection bucketing in `ImportConfigReviewModal.tsx`**

Update `KIND_LABEL` (currently lines 9-14):

```typescript
const KIND_LABEL: Record<ImportCandidate['kind'], string> = {
  rule: 'Import as Rule',
  workflow: 'Import as Workflow',
  skill: 'Import as Skill',
  mcp: 'Import as Connector',
  unsupported: 'Not yet supported'
}
```

`importable`/`skipped` (currently lines 32-33) already filter on `c.kind !== 'unsupported' && c.buildable` / `!c.buildable` — since MCP candidates are always `buildable: true` (Task 3), they fall into `importable` automatically with no change needed there.

Update `doImport`'s selection object (currently lines 93-99) to add the new bucket:

```typescript
    const selection = {
      rules: importable.filter((c) => c.kind === 'rule' && selected.has(c.sourcePath)).map((c) => c.sourcePath),
      workflows: importable
        .filter((c) => c.kind === 'workflow' && selected.has(c.sourcePath))
        .map((c) => c.sourcePath),
      skills: importable.filter((c) => c.kind === 'skill' && selected.has(c.sourcePath)).map((c) => c.sourcePath),
      mcpServers: importable
        .filter((c) => c.kind === 'mcp' && selected.has(c.sourcePath))
        .map((c) => c.sourcePath)
    }
```

- [ ] **Step 2: Extend `ORIGIN_LABEL` in `ConnectorsPage.tsx`**

Update (currently lines 62-65):

```typescript
const ORIGIN_LABEL: Record<DiscoveredMcpServer['origin'], string> = {
  'claude-desktop': 'Claude Desktop',
  'project-mcp-json': 'project .mcp.json',
  'claude-settings-json': '.claude/settings.json',
  'cursor-mcp-json': '.cursor/mcp.json',
  'windsurf-mcp-json': '.windsurf/mcp.json'
}
```

(TypeScript's `Record<DiscoveredMcpServer['origin'], string>` already forces this to be exhaustive once Task 1's type extension lands — if this file still compiles without the 3 new keys, something is wrong with Task 1's edit; verify by running tsc before adding these manually, to confirm it actually fails first.)

- [ ] **Step 3: Extend the import-confirmation toast in `store.ts`**

Update the `applyImportSelection` action's toast-message-building block (currently ~lines 1446-1450):

```typescript
      const parts: string[] = []
      if (summary.rulesImported > 0) parts.push(plural(summary.rulesImported, 'rule'))
      if (summary.workflowsImported > 0) parts.push(plural(summary.workflowsImported, 'workflow'))
      if (summary.skillsImported > 0) parts.push(plural(summary.skillsImported, 'skill'))
      if (summary.mcpServersImported > 0) parts.push(plural(summary.mcpServersImported, 'connector'))
      get().showToast(parts.length === 0 ? 'Nothing was imported' : `Imported ${parts.join(', ')}`)
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline (2)

Run: `npx tsc --noEmit -p tsconfig.node.json` (ConnectorsPage/store.ts edits are renderer-only, but this catches anything unexpected)
Expected: no new errors beyond baseline (16)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ImportConfigReviewModal.tsx src/renderer/src/components/Settings/pages/ConnectorsPage.tsx src/renderer/src/state/store.ts
git commit -m "feat(config-import): surface MCP servers as a fourth bucket in the review modal"
```

---

### Task 6: Live smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Build and launch**

Run: `npm run dev` (kill any stale `electron-vite`/`electron` processes first, per house convention)

- [ ] **Step 2: Manual walkthrough**

1. Open a scratch folder containing `.claude/settings.json` with a `mcpServers` entry, and a `.cursor/mcp.json` with another.
2. Trigger a scan (banner, or the "Scan for importable config…" button in Settings → Rules).
3. Confirm both MCP servers appear in the Review & Import modal under "Import as Connector," alongside any rules/workflows/skills also detected.
4. Import one, confirm the toast mentions "1 connector" (or similar), and confirm it shows up in Settings → Connectors, in the untrusted/disabled state.
5. Re-scan — confirm the imported server no longer reappears as a candidate.
6. Open Settings → Connectors → "Import local…" directly (bypassing the banner) — confirm it also lists `.claude/settings.json`/`.cursor/mcp.json`/`.windsurf/mcp.json` sources now, unaffected by anything imported via the unified modal.

- [ ] **Step 3: Report results to the user before considering this plan done.**
