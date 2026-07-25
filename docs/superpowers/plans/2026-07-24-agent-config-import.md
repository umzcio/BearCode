# Agent Config Import (Plan A: Rules/Workflows/Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On project folder open, detect `CLAUDE.md`/`AGENTS.md`/`.cursorrules`/`.windsurfrules`-style instructions, `.claude/commands`, and `.claude/skills`, and let the user review and import them into BearCode's own `.agents/rules`, `.agents/workflows`, and `.agents/skills`.

**Architecture:** A new `src/main/configImport/` module does pure detection (fs existence scan) and translation (read + resolve `@path` refs, reusing `agentsDir`'s exported `resolveRuleRefs`), completely decoupled from Electron/DB so it unit-tests like the rest of `agentsDir`. A thin DB table tracks what's been imported or dismissed, keyed by `(project_path, source_path)`, driving the "remind after a week" banner logic and the "Check for updates" diff flow. The renderer gets one new banner (modeled on `TrustBanner`) and one new review modal (modeled on `BrowseSmitheryModal`), both wired through the existing IPC/preload/store patterns.

**Tech Stack:** Electron main process (Node fs, better-sqlite3), React 19 renderer, vitest.

**Deviation from spec:** the approved spec listed Claude Code hooks and subagents both as "detected but not yet supported." Detecting hooks requires parsing `.claude/settings.json`'s `hooks` key — the same file Plan B already opens to read `mcpServers` — so hook detection is deferred to Plan B to avoid two separate JSON-parsing paths over the same file. This plan still detects `.claude/agents/*.md` (subagents) as "not yet supported," since that's a plain file-existence check like commands/skills.

## Global Constraints

- Pure Node builtins only in `src/main/configImport/` — no new npm dependencies (matches `agentsDir`'s existing constraint).
- Never throw out of a detection/translation function: missing/unreadable/malformed input degrades to skipping that item, never crashes the scan (matches `agentsDir`/`mcp/store.ts` house style).
- Reads are capped at 64KB via the existing `readFileCapped` (`src/main/fsCapped.ts`), same cap `agentsDir` uses for rule/workflow/skill files.
- New DB table follows the existing schema style in `src/main/db/index.ts`: one `CREATE TABLE IF NOT EXISTS` in the startup `db.exec` block, no separate migration framework.
- Vitest gate: `npx vitest run`. Typecheck gate: `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`. Baseline pre-existing errors are 17 node-tc / 2 web-tc — anything above that is a regression.
- Auto-fix scope: `npx eslint --fix <specific paths>` only, never the bare `lint` script.

---

### Task 1: `imported_config_sources` table + CRUD

**Files:**
- Modify: `src/main/db/index.ts`
- Test: `src/main/db/importedConfig.test.ts`

**Interfaces:**
- Produces: `ImportedConfigStatus = 'imported' | 'dismissed'`, `ImportedConfigRow { id: string; projectPath: string; sourcePath: string; sourceHash: string | null; importedAsType: 'rule' | 'workflow' | 'skill' | null; importedAsName: string | null; status: ImportedConfigStatus; dismissedAt: number | null; createdAt: number }`, `upsertImportedConfig(projectPath: string, sourcePath: string, patch: Partial<Omit<ImportedConfigRow, 'id' | 'projectPath' | 'sourcePath'>>): void`, `listImportedConfig(projectPath: string): ImportedConfigRow[]`, `getImportedConfig(projectPath: string, sourcePath: string): ImportedConfigRow | null`, `deleteImportedConfig(projectPath: string, sourcePath: string): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/db/importedConfig.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { upsertImportedConfig, listImportedConfig, getImportedConfig, deleteImportedConfig } from './index'

describe('imported_config_sources', () => {
  const proj = '/tmp/test-project'

  it('upserts and reads back a row', () => {
    upsertImportedConfig(proj, 'CLAUDE.md', {
      sourceHash: 'abc123',
      importedAsType: 'rule',
      importedAsName: 'claude-md',
      status: 'imported',
      createdAt: 1000
    })
    const row = getImportedConfig(proj, 'CLAUDE.md')
    expect(row).toMatchObject({
      projectPath: proj,
      sourcePath: 'CLAUDE.md',
      sourceHash: 'abc123',
      importedAsType: 'rule',
      importedAsName: 'claude-md',
      status: 'imported'
    })
  })

  it('updates only the patched columns on a second upsert', () => {
    upsertImportedConfig(proj, 'AGENTS.md', {
      sourceHash: 'h1',
      status: 'imported',
      importedAsType: 'rule',
      importedAsName: 'agents-md',
      createdAt: 2000
    })
    upsertImportedConfig(proj, 'AGENTS.md', { sourceHash: 'h2' })
    const row = getImportedConfig(proj, 'AGENTS.md')
    expect(row?.sourceHash).toBe('h2')
    expect(row?.importedAsName).toBe('agents-md')
  })

  it('lists all rows for a project', () => {
    upsertImportedConfig(proj, '.cursorrules', { status: 'dismissed', dismissedAt: 5000, createdAt: 5000 })
    const rows = listImportedConfig(proj)
    expect(rows.map((r) => r.sourcePath)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.cursorrules'])
    )
  })

  it('deletes a row', () => {
    deleteImportedConfig(proj, '.cursorrules')
    expect(getImportedConfig(proj, '.cursorrules')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/db/importedConfig.test.ts`
Expected: FAIL — `upsertImportedConfig` is not exported from `./index`.

- [ ] **Step 3: Add the table and CRUD functions**

In `src/main/db/index.ts`, add to the `db.exec` schema block (right after the `project_settings` table, ~line 113):

```sql
    CREATE TABLE IF NOT EXISTS imported_config_sources (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT,
      imported_as_type TEXT,
      imported_as_name TEXT,
      status TEXT NOT NULL,
      dismissed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_config_source
      ON imported_config_sources(project_path, source_path);
```

Then add near `upsertProjectSettings` (after the Project Trust section, ~line 1126):

```typescript
export interface ImportedConfigRow {
  id: string
  projectPath: string
  sourcePath: string
  sourceHash: string | null
  importedAsType: 'rule' | 'workflow' | 'skill' | null
  importedAsName: string | null
  status: 'imported' | 'dismissed'
  dismissedAt: number | null
  createdAt: number
}

interface ImportedConfigDbRow {
  id: string
  project_path: string
  source_path: string
  source_hash: string | null
  imported_as_type: string | null
  imported_as_name: string | null
  status: string
  dismissed_at: number | null
  created_at: number
}

function rowToImportedConfig(r: ImportedConfigDbRow): ImportedConfigRow {
  return {
    id: r.id,
    projectPath: r.project_path,
    sourcePath: r.source_path,
    sourceHash: r.source_hash,
    importedAsType: r.imported_as_type as ImportedConfigRow['importedAsType'],
    importedAsName: r.imported_as_name,
    status: r.status as ImportedConfigRow['status'],
    dismissedAt: r.dismissed_at,
    createdAt: r.created_at
  }
}

export function upsertImportedConfig(
  projectPath: string,
  sourcePath: string,
  patch: Partial<Omit<ImportedConfigRow, 'id' | 'projectPath' | 'sourcePath'>>
): void {
  const database = getDb()
  const id = randomUUID()
  const createdAt = patch.createdAt ?? Date.now()
  database
    .prepare(
      `INSERT OR IGNORE INTO imported_config_sources
         (id, project_path, source_path, status, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, projectPath, sourcePath, patch.status ?? 'imported', createdAt)

  const cols: string[] = []
  const vals: (string | number | null)[] = []
  if (patch.sourceHash !== undefined) {
    cols.push('source_hash = ?')
    vals.push(patch.sourceHash)
  }
  if (patch.importedAsType !== undefined) {
    cols.push('imported_as_type = ?')
    vals.push(patch.importedAsType)
  }
  if (patch.importedAsName !== undefined) {
    cols.push('imported_as_name = ?')
    vals.push(patch.importedAsName)
  }
  if (patch.status !== undefined) {
    cols.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.dismissedAt !== undefined) {
    cols.push('dismissed_at = ?')
    vals.push(patch.dismissedAt)
  }
  if (cols.length === 0) return
  database
    .prepare(
      `UPDATE imported_config_sources SET ${cols.join(', ')} WHERE project_path = ? AND source_path = ?`
    )
    .run(...vals, projectPath, sourcePath)
}

export function getImportedConfig(projectPath: string, sourcePath: string): ImportedConfigRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM imported_config_sources WHERE project_path = ? AND source_path = ?`)
    .get(projectPath, sourcePath) as ImportedConfigDbRow | undefined
  return row ? rowToImportedConfig(row) : null
}

export function listImportedConfig(projectPath: string): ImportedConfigRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM imported_config_sources WHERE project_path = ?`)
    .all(projectPath) as ImportedConfigDbRow[]
  return rows.map(rowToImportedConfig)
}

export function deleteImportedConfig(projectPath: string, sourcePath: string): void {
  getDb()
    .prepare(`DELETE FROM imported_config_sources WHERE project_path = ? AND source_path = ?`)
    .run(projectPath, sourcePath)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/db/importedConfig.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/db/index.ts src/main/db/importedConfig.test.ts
git commit -m "feat(config-import): add imported_config_sources table + CRUD"
```

---

### Task 2: Detection scan

**Files:**
- Create: `src/main/configImport/types.ts`
- Create: `src/main/configImport/scan.ts`
- Test: `src/main/configImport/scan.test.ts`

**Interfaces:**
- Consumes: nothing new (pure `fs`)
- Produces: `ImportTool = 'claude-code' | 'codex' | 'cursor' | 'windsurf'`, `ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported'`, `DetectedSource { sourcePath: string; kind: ImportKind; tool: ImportTool }`, `scanImportableConfig(projectPath: string): DetectedSource[]`, `shouldShowImportBanner(detected: DetectedSource[], known: ImportedConfigRow[], nowMs: number): boolean` (7-day re-remind logic, `ImportedConfigRow` imported as a type only from `../db`)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/scan.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanImportableConfig, shouldShowImportBanner } from './scan'

describe('scanImportableConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds nothing in an empty project', () => {
    expect(scanImportableConfig(dir)).toEqual([])
  })

  it('detects CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'x')
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    writeFileSync(join(dir, '.cursorrules'), 'x')
    writeFileSync(join(dir, '.windsurfrules'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toEqual(
      expect.arrayContaining([
        { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' },
        { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' },
        { sourcePath: '.cursorrules', kind: 'rule', tool: 'cursor' },
        { sourcePath: '.windsurfrules', kind: 'rule', tool: 'windsurf' }
      ])
    )
  })

  it('detects .cursor/rules/*.md and .windsurf/rules/*.md', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.md'), 'x')
    mkdirSync(join(dir, '.windsurf', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.windsurf', 'rules', 'style.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.cursor', 'rules', 'testing.md'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(found).toContainEqual({
      sourcePath: join('.windsurf', 'rules', 'style.md'),
      kind: 'rule',
      tool: 'windsurf'
    })
  })

  it('detects .claude/commands/*.md as workflows', () => {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', 'deploy.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'commands', 'deploy.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
  })

  it('detects .claude/skills/<name>/SKILL.md folders as skills', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'), 'x')
    mkdirSync(join(dir, '.claude', 'skills', 'no-skill-md'), { recursive: true })
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(found.some((f) => f.sourcePath.includes('no-skill-md'))).toBe(false)
  })

  it('detects .claude/agents/*.md as unsupported', () => {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'agents', 'reviewer.md'),
      kind: 'unsupported',
      tool: 'claude-code'
    })
  })
})

describe('shouldShowImportBanner', () => {
  const detected = [{ sourcePath: 'CLAUDE.md', kind: 'rule' as const, tool: 'claude-code' as const }]

  it('shows the banner when a source was never seen before', () => {
    expect(shouldShowImportBanner(detected, [], 1000)).toBe(true)
  })

  it('does not show the banner for an already-imported source', () => {
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: 'h',
        importedAsType: 'rule' as const,
        importedAsName: 'claude-md',
        status: 'imported' as const,
        dismissedAt: null,
        createdAt: 0
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000)).toBe(false)
  })

  it('does not show the banner within 7 days of a dismissal', () => {
    const oneDayMs = 24 * 60 * 60 * 1000
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: null,
        importedAsType: null,
        importedAsName: null,
        status: 'dismissed' as const,
        dismissedAt: 1000,
        createdAt: 1000
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000 + oneDayMs)).toBe(false)
  })

  it('re-shows the banner after 7 days past a dismissal', () => {
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: null,
        importedAsType: null,
        importedAsName: null,
        status: 'dismissed' as const,
        dismissedAt: 1000,
        createdAt: 1000
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000 + eightDaysMs)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/scan.test.ts`
Expected: FAIL — cannot find module `./scan`

- [ ] **Step 3: Write `types.ts` and `scan.ts`**

```typescript
// src/main/configImport/types.ts
export type ImportTool = 'claude-code' | 'codex' | 'cursor' | 'windsurf'
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported'

export interface DetectedSource {
  sourcePath: string
  kind: ImportKind
  tool: ImportTool
}
```

```typescript
// src/main/configImport/scan.ts
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ImportedConfigRow } from '../db'
import type { DetectedSource, ImportTool } from './types'

const INSTRUCTION_FILES: { rel: string; tool: ImportTool }[] = [
  { rel: 'CLAUDE.md', tool: 'claude-code' },
  { rel: 'AGENTS.md', tool: 'codex' },
  { rel: '.cursorrules', tool: 'cursor' },
  { rel: '.windsurfrules', tool: 'windsurf' }
]

function listMdFilesRel(projectPath: string, dirRel: string): string[] {
  const dir = join(projectPath, dirRel)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dirRel, f))
  } catch {
    return []
  }
}

function listSkillDirsRel(projectPath: string, dirRel: string): string[] {
  const dir = join(projectPath, dirRel)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
      .map((d) => join(dirRel, d.name))
  } catch {
    return []
  }
}

// Cheap existence-only scan (no parsing) for external agent-tool config,
// mirroring hasProjectAgentsConfig's cheapness in agentsDir/index.ts.
export function scanImportableConfig(projectPath: string): DetectedSource[] {
  const found: DetectedSource[] = []

  for (const { rel, tool } of INSTRUCTION_FILES) {
    if (existsSync(join(projectPath, rel))) {
      found.push({ sourcePath: rel, kind: 'rule', tool })
    }
  }
  for (const rel of listMdFilesRel(projectPath, join('.cursor', 'rules'))) {
    found.push({ sourcePath: rel, kind: 'rule', tool: 'cursor' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.windsurf', 'rules'))) {
    found.push({ sourcePath: rel, kind: 'rule', tool: 'windsurf' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.claude', 'commands'))) {
    found.push({ sourcePath: rel, kind: 'workflow', tool: 'claude-code' })
  }
  for (const rel of listSkillDirsRel(projectPath, join('.claude', 'skills'))) {
    found.push({ sourcePath: rel, kind: 'skill', tool: 'claude-code' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.claude', 'agents'))) {
    found.push({ sourcePath: rel, kind: 'unsupported', tool: 'claude-code' })
  }
  return found
}

const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// Pure decision function (no Date.now() inside — the caller supplies `nowMs`
// so this stays trivially testable). Shows the banner when at least one
// detected source has no DB row at all, or was dismissed >= 7 days ago.
export function shouldShowImportBanner(
  detected: DetectedSource[],
  known: ImportedConfigRow[],
  nowMs: number
): boolean {
  const byPath = new Map(known.map((k) => [k.sourcePath, k]))
  return detected.some((d) => {
    const row = byPath.get(d.sourcePath)
    if (!row) return true
    if (row.status === 'dismissed') {
      return row.dismissedAt !== null && nowMs - row.dismissedAt >= REMIND_AFTER_MS
    }
    return false
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/scan.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/types.ts src/main/configImport/scan.ts src/main/configImport/scan.test.ts
git commit -m "feat(config-import): detect external agent config on folder scan"
```

---

### Task 3: Rule candidate translator

**Files:**
- Create: `src/main/configImport/translateRules.ts`
- Test: `src/main/configImport/translateRules.test.ts`

**Interfaces:**
- Consumes: `readFileCapped` (`../fsCapped`), `resolveRuleRefs` (`../agentsDir`, already exported), `DetectedSource` (`./types`)
- Produces: `RuleCandidate { sourcePath: string; suggestedName: string; body: string; warnings: string[] }`, `buildRuleCandidate(projectPath: string, source: DetectedSource): RuleCandidate | null`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/translateRules.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRuleCandidate } from './translateRules'

describe('buildRuleCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-rules-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a kebab-case name from the source filename', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toMatchObject({ sourcePath: 'CLAUDE.md', suggestedName: 'claude', body: 'Always use tabs.' })
  })

  it('derives a name for a nested rule file', () => {
    writeFileSync(join(dir, 'testing.md'), 'Use vitest.')
    const c = buildRuleCandidate(dir, {
      sourcePath: join('.cursor', 'rules', 'testing.md'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(c?.suggestedName).toBe('testing')
  })

  it('resolves @path references using the shared rule-ref resolver', () => {
    writeFileSync(join(dir, 'shared.md'), 'Shared conventions.')
    writeFileSync(join(dir, 'CLAUDE.md'), 'See @shared.md for conventions.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c?.body).toContain('Shared conventions.')
    expect(c?.warnings).toEqual([])
  })

  it('returns null for a missing file', () => {
    const c = buildRuleCandidate(dir, { sourcePath: 'MISSING.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toBeNull()
  })

  it('returns null for an empty/whitespace-only file', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n  ')
    const c = buildRuleCandidate(dir, { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' })
    expect(c).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/translateRules.test.ts`
Expected: FAIL — cannot find module `./translateRules`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/translateRules.ts
import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { resolveRuleRefs } from '../agentsDir'
import type { DetectedSource } from './types'

const MAX_IMPORT_BYTES = 64 * 1024

export interface RuleCandidate {
  sourcePath: string
  suggestedName: string
  body: string
  warnings: string[]
}

// Kebab-cases the source file's basename (minus extension and any leading
// dot) into a rule name. "CLAUDE.md" -> "claude", ".cursorrules" ->
// "cursorrules", ".cursor/rules/testing.md" -> "testing".
function nameFromSourcePath(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() ?? sourcePath
  const stem = base.replace(/\.md$/, '').replace(/^\.+/, '')
  const kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? 'imported-rule' : kebab
}

export function buildRuleCandidate(
  projectPath: string,
  source: DetectedSource
): RuleCandidate | null {
  const abs = join(projectPath, source.sourcePath)
  const read = readFileCapped(abs, MAX_IMPORT_BYTES)
  if (!read || read.text.trim() === '') return null

  const { body, warnings } = resolveRuleRefs(read.text, projectPath, {
    inlinedChain: new Set([abs])
  })

  return {
    sourcePath: source.sourcePath,
    suggestedName: nameFromSourcePath(source.sourcePath),
    body,
    warnings: read.truncated
      ? [...warnings, `${source.sourcePath} exceeds ${MAX_IMPORT_BYTES / 1024}KB and was truncated`]
      : warnings
  }
}
```

Also add `resolveRuleRefs` to the re-exports in `src/main/agentsDir/index.ts` if not already exported at the top level — it already is (`export function resolveRuleRefs` at line 444), so no change needed there.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/translateRules.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/translateRules.ts src/main/configImport/translateRules.test.ts
git commit -m "feat(config-import): translate instruction files into rule candidates"
```

---

### Task 4: Workflow candidate translator

**Files:**
- Create: `src/main/configImport/translateWorkflows.ts`
- Test: `src/main/configImport/translateWorkflows.test.ts`

**Interfaces:**
- Consumes: `readFileCapped` (`../fsCapped`), `COMMAND_NAME_PATTERN` (`../../shared/types`), `DetectedSource` (`./types`)
- Produces: `WorkflowCandidate { sourcePath: string; suggestedName: string; body: string; warnings: string[] }`, `buildWorkflowCandidate(projectPath: string, source: DetectedSource): WorkflowCandidate | null`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/translateWorkflows.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkflowCandidate } from './translateWorkflows'

describe('buildWorkflowCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-workflows-'))
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a kebab-case workflow name from the command filename', () => {
    writeFileSync(join(dir, '.claude', 'commands', 'deploy.md'), '1. Run the deploy script.')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'deploy.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toMatchObject({ suggestedName: 'deploy', body: '1. Run the deploy script.' })
  })

  it('returns null for a name that cannot be made kebab-case-valid', () => {
    writeFileSync(join(dir, '.claude', 'commands', '__.md'), 'body')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', '__.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null for an empty command file', () => {
    writeFileSync(join(dir, '.claude', 'commands', 'empty.md'), '')
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'empty.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null for a missing file', () => {
    const c = buildWorkflowCandidate(dir, {
      sourcePath: join('.claude', 'commands', 'missing.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/translateWorkflows.test.ts`
Expected: FAIL — cannot find module `./translateWorkflows`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/translateWorkflows.ts
import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { DetectedSource } from './types'

const MAX_IMPORT_BYTES = 64 * 1024

export interface WorkflowCandidate {
  sourcePath: string
  suggestedName: string
  body: string
  warnings: string[]
}

function nameFromSourcePath(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() ?? sourcePath
  const stem = base.replace(/\.md$/, '')
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function buildWorkflowCandidate(
  projectPath: string,
  source: DetectedSource
): WorkflowCandidate | null {
  const abs = join(projectPath, source.sourcePath)
  const read = readFileCapped(abs, MAX_IMPORT_BYTES)
  if (!read || read.text.trim() === '') return null

  const suggestedName = nameFromSourcePath(source.sourcePath)
  if (!COMMAND_NAME_PATTERN.test(suggestedName)) return null

  return {
    sourcePath: source.sourcePath,
    suggestedName,
    body: read.text,
    warnings: read.truncated
      ? [`${source.sourcePath} exceeds ${MAX_IMPORT_BYTES / 1024}KB and was truncated`]
      : []
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/translateWorkflows.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/translateWorkflows.ts src/main/configImport/translateWorkflows.test.ts
git commit -m "feat(config-import): translate .claude/commands into workflow candidates"
```

---

### Task 5: Skill candidate lister + pre-validation

**Files:**
- Create: `src/main/configImport/translateSkills.ts`
- Test: `src/main/configImport/translateSkills.test.ts`

**Interfaces:**
- Consumes: `readFileCapped` (`../fsCapped`), `parseSkillFolder` (`../agentsDir/parseSkill`), `DetectedSource` (`./types`)
- Produces: `SkillCandidate { sourcePath: string; suggestedName: string; description: string }`, `buildSkillCandidate(projectPath: string, source: DetectedSource): SkillCandidate | null`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/translateSkills.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSkillCandidate } from './translateSkills'

describe('buildSkillCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-skills-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns a candidate for a valid SKILL.md', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody text.'
    )
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toMatchObject({
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      suggestedName: 'pdf-export',
      description: 'Export docs to PDF'
    })
  })

  it('returns null when SKILL.md is missing a required description', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'broken', 'SKILL.md'), 'no frontmatter at all')
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'broken'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null when SKILL.md is missing entirely', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'empty-dir'), { recursive: true })
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'empty-dir'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/translateSkills.test.ts`
Expected: FAIL — cannot find module `./translateSkills`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/translateSkills.ts
import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { parseSkillFolder } from '../agentsDir/parseSkill'
import type { DetectedSource } from './types'

const MAX_IMPORT_BYTES = 64 * 1024

export interface SkillCandidate {
  sourcePath: string
  suggestedName: string
  description: string
}

export function buildSkillCandidate(
  projectPath: string,
  source: DetectedSource
): SkillCandidate | null {
  const folderName = source.sourcePath.split(/[/\\]/).pop() ?? source.sourcePath
  const skillMdPath = join(projectPath, source.sourcePath, 'SKILL.md')
  const read = readFileCapped(skillMdPath, MAX_IMPORT_BYTES)
  if (!read) return null

  const parsed = parseSkillFolder(folderName, read.text, 'project')
  if (parsed.error) return null

  return {
    sourcePath: source.sourcePath,
    suggestedName: parsed.name,
    description: parsed.description
  }
}
```

Check `parseSkillFolder`'s exact export name/signature in `src/main/agentsDir/parseSkill.ts` before wiring this up — it should mirror `parseRuleFile(name, raw, source)`'s shape per Task 1's exploration; adjust the call if the real signature differs (e.g. argument order).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/translateSkills.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/translateSkills.ts src/main/configImport/translateSkills.test.ts
git commit -m "feat(config-import): validate .claude/skills folders as skill candidates"
```

---

### Task 6: Importer — collision-safe write + DB recording

**Files:**
- Create: `src/main/configImport/importer.ts`
- Test: `src/main/configImport/importer.test.ts`

**Interfaces:**
- Consumes: `scanImportableConfig` (`./scan`), `buildRuleCandidate` (`./translateRules`), `buildWorkflowCandidate` (`./translateWorkflows`), `buildSkillCandidate` (`./translateSkills`), `upsertImportedConfig` (`../db`)
- Produces: `ImportSelection { rules: string[]; workflows: string[]; skills: string[] }` (each array is the chosen `sourcePath`s), `ImportSummary { rulesImported: number; workflowsImported: number; skillsImported: number }`, `applyImportSelection(projectPath: string, selection: ImportSelection): ImportSummary`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/importer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyImportSelection } from './importer'
import { getImportedConfig } from '../db'

describe('applyImportSelection', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-importer-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes an imported rule file and records it', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')
    const summary = applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
    expect(summary).toEqual({ rulesImported: 1, workflowsImported: 0, skillsImported: 0 })
    const written = readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')
    expect(written).toBe('Always use tabs.')
    const row = getImportedConfig(dir, 'CLAUDE.md')
    expect(row).toMatchObject({ importedAsType: 'rule', importedAsName: 'claude', status: 'imported' })
  })

  it('suffixes the name on a collision instead of overwriting', () => {
    mkdirSync(join(dir, '.agents', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'existing rule, do not touch')
    writeFileSync(join(dir, 'CLAUDE.md'), 'new content')
    applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe(
      'existing rule, do not touch'
    )
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude-imported.md'), 'utf8')).toBe(
      'new content'
    )
  })

  it('copies a skill folder verbatim', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody.'
    )
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [],
      skills: [join('.claude', 'skills', 'pdf-export')]
    })
    expect(summary.skillsImported).toBe(1)
    expect(existsSync(join(dir, '.agents', 'skills', 'pdf-export', 'SKILL.md'))).toBe(true)
  })

  it('skips a selection whose candidate no longer builds (e.g. file deleted)', () => {
    const summary = applyImportSelection(dir, { rules: ['GONE.md'], workflows: [], skills: [] })
    expect(summary.rulesImported).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/importer.test.ts`
Expected: FAIL — cannot find module `./importer`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/importer.ts
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { scanImportableConfig } from './scan'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import { buildSkillCandidate } from './translateSkills'
import { upsertImportedConfig } from '../db'

export interface ImportSelection {
  rules: string[]
  workflows: string[]
  skills: string[]
}

export interface ImportSummary {
  rulesImported: number
  workflowsImported: number
  skillsImported: number
}

// Picks the first available filename by appending "-imported", then
// "-imported-2", "-imported-3", ... — never overwrites an existing file.
function uniqueTargetPath(dir: string, baseName: string, ext: string): string {
  const plain = join(dir, `${baseName}${ext}`)
  if (!existsSync(plain)) return plain
  const withSuffix = join(dir, `${baseName}-imported${ext}`)
  if (!existsSync(withSuffix)) return withSuffix
  let n = 2
  while (existsSync(join(dir, `${baseName}-imported-${n}${ext}`))) n++
  return join(dir, `${baseName}-imported-${n}${ext}`)
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function applyImportSelection(
  projectPath: string,
  selection: ImportSelection
): ImportSummary {
  const detected = scanImportableConfig(projectPath)
  const bySourcePath = new Map(detected.map((d) => [d.sourcePath, d]))
  const summary: ImportSummary = { rulesImported: 0, workflowsImported: 0, skillsImported: 0 }

  const rulesDir = join(projectPath, '.agents', 'rules')
  for (const sourcePath of selection.rules) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildRuleCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(rulesDir, { recursive: true })
    const target = uniqueTargetPath(rulesDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'rule',
      importedAsName: target.slice(rulesDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.rulesImported++
  }

  const workflowsDir = join(projectPath, '.agents', 'workflows')
  for (const sourcePath of selection.workflows) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildWorkflowCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(workflowsDir, { recursive: true })
    const target = uniqueTargetPath(workflowsDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'workflow',
      importedAsName: target.slice(workflowsDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.workflowsImported++
  }

  const skillsDir = join(projectPath, '.agents', 'skills')
  for (const sourcePath of selection.skills) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildSkillCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(skillsDir, { recursive: true })
    let targetName = candidate.suggestedName
    if (existsSync(join(skillsDir, targetName))) {
      targetName = `${candidate.suggestedName}-imported`
      let n = 2
      while (existsSync(join(skillsDir, targetName))) {
        targetName = `${candidate.suggestedName}-imported-${n}`
        n++
      }
    }
    cpSync(join(projectPath, sourcePath), join(skillsDir, targetName), { recursive: true })
    const rawText = readFileSync(join(projectPath, sourcePath, 'SKILL.md'), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'skill',
      importedAsName: targetName,
      status: 'imported',
      createdAt: Date.now()
    })
    summary.skillsImported++
  }

  return summary
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/importer.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/importer.ts src/main/configImport/importer.test.ts
git commit -m "feat(config-import): write selected candidates into .agents/ with collision-safe naming"
```

---

### Task 7: Check-for-updates + dismiss/detach

**Files:**
- Create: `src/main/configImport/checkUpdates.ts`
- Test: `src/main/configImport/checkUpdates.test.ts`

**Interfaces:**
- Consumes: `getImportedConfig`, `upsertImportedConfig`, `deleteImportedConfig` (`../db`), `buildRuleCandidate`/`buildWorkflowCandidate`/`buildSkillCandidate` translators
- Produces: `UpdateCheck = { state: 'up-to-date' } | { state: 'changed'; oldBody: string; newBody: string } | { state: 'source-missing' }`, `checkSourceForUpdate(projectPath: string, sourcePath: string): UpdateCheck`, `applySourceUpdate(projectPath: string, sourcePath: string): void`, `ignoreSourceUpdate(projectPath: string, sourcePath: string): void`, `detachSource(projectPath: string, sourcePath: string): void`, `dismissDetectedSources(projectPath: string, sourcePaths: string[]): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/configImport/checkUpdates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyImportSelection } from './importer'
import {
  checkSourceForUpdate,
  applySourceUpdate,
  ignoreSourceUpdate,
  detachSource,
  dismissDetectedSources
} from './checkUpdates'
import { getImportedConfig } from '../db'

describe('checkSourceForUpdate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-checkupdate-'))
    writeFileSync(join(dir, 'CLAUDE.md'), 'Original content.')
    applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports up-to-date when the source is unchanged', () => {
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
  })

  it('reports a diff when the source changed', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    const result = checkSourceForUpdate(dir, 'CLAUDE.md')
    expect(result).toMatchObject({ state: 'changed', newBody: 'Updated content.' })
  })

  it('reports source-missing when the file was deleted', () => {
    rmSync(join(dir, 'CLAUDE.md'))
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'source-missing' })
  })

  it('applySourceUpdate overwrites the imported rule with the new content', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    applySourceUpdate(dir, 'CLAUDE.md')
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Updated content.')
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
  })

  it('ignoreSourceUpdate stops flagging the same change as new', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    ignoreSourceUpdate(dir, 'CLAUDE.md')
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Original content.')
  })

  it('detachSource removes the tracking row without touching the imported file', () => {
    detachSource(dir, 'CLAUDE.md')
    expect(getImportedConfig(dir, 'CLAUDE.md')).toBeNull()
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Original content.')
  })
})

describe('dismissDetectedSources', () => {
  it('marks each source dismissed with the current timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bearcode-dismiss-'))
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    dismissDetectedSources(dir, ['AGENTS.md'])
    const row = getImportedConfig(dir, 'AGENTS.md')
    expect(row?.status).toBe('dismissed')
    expect(row?.dismissedAt).not.toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/configImport/checkUpdates.test.ts`
Expected: FAIL — cannot find module `./checkUpdates`

- [ ] **Step 3: Implement**

```typescript
// src/main/configImport/checkUpdates.ts
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { getImportedConfig, upsertImportedConfig, deleteImportedConfig } from '../db'
import { scanImportableConfig } from './scan'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'

export type UpdateCheck =
  | { state: 'up-to-date' }
  | { state: 'changed'; oldBody: string; newBody: string }
  | { state: 'source-missing' }

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function candidateBody(projectPath: string, sourcePath: string): string | null {
  const source = scanImportableConfig(projectPath).find((d) => d.sourcePath === sourcePath)
  if (!source) return null
  if (source.kind === 'rule') return buildRuleCandidate(projectPath, source)?.body ?? null
  if (source.kind === 'workflow') return buildWorkflowCandidate(projectPath, source)?.body ?? null
  return null // skills are diffed as whole folders — out of scope for the text-diff check
}

export function checkSourceForUpdate(projectPath: string, sourcePath: string): UpdateCheck {
  const row = getImportedConfig(projectPath, sourcePath)
  const abs = join(projectPath, sourcePath)
  if (!existsSync(abs)) return { state: 'source-missing' }

  const rawText = readFileSync(abs, 'utf8')
  const currentHash = hashOf(rawText)
  if (row?.sourceHash === currentHash) return { state: 'up-to-date' }

  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null || !row?.importedAsType || !row.importedAsName) return { state: 'up-to-date' }

  const dir = join(projectPath, '.agents', row.importedAsType === 'rule' ? 'rules' : 'workflows')
  const oldPath = join(dir, `${row.importedAsName}.md`)
  const oldBody = existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : ''
  return { state: 'changed', oldBody, newBody }
}

export function applySourceUpdate(projectPath: string, sourcePath: string): void {
  const row = getImportedConfig(projectPath, sourcePath)
  if (!row?.importedAsType || !row.importedAsName) return
  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null) return
  const dir = join(projectPath, '.agents', row.importedAsType === 'rule' ? 'rules' : 'workflows')
  writeFileSync(join(dir, `${row.importedAsName}.md`), newBody)
  const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
  upsertImportedConfig(projectPath, sourcePath, { sourceHash: hashOf(rawText) })
}

export function ignoreSourceUpdate(projectPath: string, sourcePath: string): void {
  const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
  upsertImportedConfig(projectPath, sourcePath, { sourceHash: hashOf(rawText) })
}

export function detachSource(projectPath: string, sourcePath: string): void {
  deleteImportedConfig(projectPath, sourcePath)
}

export function dismissDetectedSources(projectPath: string, sourcePaths: string[]): void {
  const now = Date.now()
  for (const sourcePath of sourcePaths) {
    upsertImportedConfig(projectPath, sourcePath, {
      status: 'dismissed',
      dismissedAt: now,
      createdAt: now
    })
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/configImport/checkUpdates.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/configImport/checkUpdates.ts src/main/configImport/checkUpdates.test.ts
git commit -m "feat(config-import): check-for-updates, ignore, detach, and dismiss flows"
```

---

### Task 8: IPC channels + preload + shared types

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces (renderer-facing, via `window.bearcode.configImport`): `scan(projectPath): Promise<{ candidates: DetectedSource[]; showBanner: boolean }>`, `apply(projectPath, selection): Promise<ImportSummary>`, `dismiss(projectPath, sourcePaths): Promise<void>`, `listImported(projectPath): Promise<ImportedConfigRow[]>`, `checkUpdate(projectPath, sourcePath): Promise<UpdateCheck>`, `applyUpdate(projectPath, sourcePath): Promise<void>`, `ignoreUpdate(projectPath, sourcePath): Promise<void>`, `detach(projectPath, sourcePath): Promise<void>`

- [ ] **Step 1: Add shared types**

In `src/shared/types.ts`, near the `mcp` block in the `window.bearcode` interface (~line 1588), add:

```typescript
export type ImportTool = 'claude-code' | 'codex' | 'cursor' | 'windsurf'
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported'
export interface DetectedSource {
  sourcePath: string
  kind: ImportKind
  tool: ImportTool
}
export interface ImportSelection {
  rules: string[]
  workflows: string[]
  skills: string[]
}
export interface ImportSummary {
  rulesImported: number
  workflowsImported: number
  skillsImported: number
}
export type UpdateCheck =
  | { state: 'up-to-date' }
  | { state: 'changed'; oldBody: string; newBody: string }
  | { state: 'source-missing' }
export interface ImportedConfigRow {
  id: string
  projectPath: string
  sourcePath: string
  sourceHash: string | null
  importedAsType: 'rule' | 'workflow' | 'skill' | null
  importedAsName: string | null
  status: 'imported' | 'dismissed'
  dismissedAt: number | null
  createdAt: number
}
```

And inside the `window.bearcode` interface body:

```typescript
  configImport: {
    scan(projectPath: string): Promise<{ candidates: DetectedSource[]; showBanner: boolean }>
    apply(projectPath: string, selection: ImportSelection): Promise<ImportSummary>
    dismiss(projectPath: string, sourcePaths: string[]): Promise<void>
    listImported(projectPath: string): Promise<ImportedConfigRow[]>
    checkUpdate(projectPath: string, sourcePath: string): Promise<UpdateCheck>
    applyUpdate(projectPath: string, sourcePath: string): Promise<void>
    ignoreUpdate(projectPath: string, sourcePath: string): Promise<void>
    detach(projectPath: string, sourcePath: string): Promise<void>
  }
```

(`ImportedConfigRow` here is the renderer-facing DTO shape — identical fields to the main-process `db.ImportedConfigRow`, kept as a separate declaration in `shared/types.ts` since main-only modules must not be imported by the renderer.)

- [ ] **Step 2: Add IPC handlers**

In `src/main/ipc.ts`, near the MCP discover/import handlers (~line 1115), add:

```typescript
import { scanImportableConfig, shouldShowImportBanner } from './configImport/scan'
import { applyImportSelection } from './configImport/importer'
import {
  checkSourceForUpdate,
  applySourceUpdate,
  ignoreSourceUpdate,
  detachSource,
  dismissDetectedSources
} from './configImport/checkUpdates'
```

```typescript
  ipcMain.handle('bearcode:config-import:scan', (_e, p: unknown) => {
    const projectPath = reqPath(p)
    const detected = scanImportableConfig(projectPath)
    const known = db.listImportedConfig(projectPath)
    const showBanner = shouldShowImportBanner(detected, known, Date.now())
    // Already-imported sources are dropped from the returned list (re-scanning
    // a folder — via the banner or the manual Settings entry point, Task 13 —
    // must not re-offer something already sitting in .agents/, which would
    // otherwise create a pointless "-imported-2" duplicate on every re-open).
    // 'unsupported' items and freshly-dismissed ones are still returned so the
    // review screen keeps showing them.
    const importedPaths = new Set(known.filter((k) => k.status === 'imported').map((k) => k.sourcePath))
    const candidates = detected.filter((d) => !importedPaths.has(d.sourcePath))
    return { candidates, showBanner }
  })
  ipcMain.handle('bearcode:config-import:apply', (_e, p: unknown, selection: unknown) => {
    return applyImportSelection(reqPath(p), selection as ImportSelection)
  })
  ipcMain.handle('bearcode:config-import:dismiss', (_e, p: unknown, sourcePaths: unknown) => {
    dismissDetectedSources(reqPath(p), sourcePaths as string[])
  })
  ipcMain.handle('bearcode:config-import:list-imported', (_e, p: unknown) =>
    db.listImportedConfig(reqPath(p))
  )
  ipcMain.handle('bearcode:config-import:check-update', (_e, p: unknown, sp: unknown) =>
    checkSourceForUpdate(reqPath(p), String(sp))
  )
  ipcMain.handle('bearcode:config-import:apply-update', (_e, p: unknown, sp: unknown) => {
    applySourceUpdate(reqPath(p), String(sp))
  })
  ipcMain.handle('bearcode:config-import:ignore-update', (_e, p: unknown, sp: unknown) => {
    ignoreSourceUpdate(reqPath(p), String(sp))
  })
  ipcMain.handle('bearcode:config-import:detach', (_e, p: unknown, sp: unknown) => {
    detachSource(reqPath(p), String(sp))
  })
```

Check `reqPath`'s exact signature at its existing use sites (e.g. line 761) before reusing it here — it should already coerce/validate an `unknown` into a non-empty path string the way every other project-scoped handler in this file does.

- [ ] **Step 3: Add preload bridge**

In `src/preload/index.ts`, near the `project` block (~line 188), add:

```typescript
  configImport: {
    scan: (projectPath: string) => ipcRenderer.invoke('bearcode:config-import:scan', projectPath),
    apply: (projectPath: string, selection: ImportSelection) =>
      ipcRenderer.invoke('bearcode:config-import:apply', projectPath, selection),
    dismiss: (projectPath: string, sourcePaths: string[]) =>
      ipcRenderer.invoke('bearcode:config-import:dismiss', projectPath, sourcePaths),
    listImported: (projectPath: string) =>
      ipcRenderer.invoke('bearcode:config-import:list-imported', projectPath),
    checkUpdate: (projectPath: string, sourcePath: string) =>
      ipcRenderer.invoke('bearcode:config-import:check-update', projectPath, sourcePath),
    applyUpdate: (projectPath: string, sourcePath: string) =>
      ipcRenderer.invoke('bearcode:config-import:apply-update', projectPath, sourcePath),
    ignoreUpdate: (projectPath: string, sourcePath: string) =>
      ipcRenderer.invoke('bearcode:config-import:ignore-update', projectPath, sourcePath),
    detach: (projectPath: string, sourcePath: string) =>
      ipcRenderer.invoke('bearcode:config-import:detach', projectPath, sourcePath)
  },
```

Add the matching `import type { ImportSelection } from '../shared/types'` (or extend whatever existing shared-types import block preload/index.ts already has).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no new errors beyond the documented 17-error baseline.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/shared/types.ts
git commit -m "feat(config-import): expose config-import IPC channels to the renderer"
```

---

### Task 9: Renderer store wiring

**Files:**
- Modify: `src/renderer/src/state/store.ts`

**Interfaces:**
- Consumes: `window.bearcode.configImport.*` (Task 8)
- Produces new store fields: `workspaceImportCandidates: DetectedSource[]`, `workspaceImportBannerVisible: boolean`, `importReviewOpen: boolean`; new actions: `refreshImportBannerState(path: string | null): Promise<void>`, `dismissImportBanner(): Promise<void>`, `openImportReview(): void`, `closeImportReview(): void`, `applyImportSelection(selection: ImportSelection): Promise<ImportSummary>`

- [ ] **Step 1: Add state fields and wire into `setWorkspace`**

Near `workspaceHasAgentsConfig` (~line 282), add:

```typescript
  workspaceImportCandidates: DetectedSource[]
  workspaceImportBannerVisible: boolean
  importReviewOpen: boolean
```

Near the initial state block (~line 634):

```typescript
    workspaceImportCandidates: [],
    workspaceImportBannerVisible: false,
    importReviewOpen: false,
```

Modify `setWorkspace` (~line 1363) to also call the new refresh:

```typescript
    setWorkspace: (path) => {
      set({ workspacePath: path })
      void get().refreshTrustState(path)
      void get().refreshImportBannerState(path)
    },
```

Add the new action after `refreshTrustState` (~line 1388):

```typescript
    refreshImportBannerState: async (path) => {
      if (!path) {
        set({ workspaceImportCandidates: [], workspaceImportBannerVisible: false })
        return
      }
      const { candidates, showBanner } = await window.bearcode.configImport.scan(path)
      set({ workspaceImportCandidates: candidates, workspaceImportBannerVisible: showBanner })
    },
    dismissImportBanner: async () => {
      const path = get().workspacePath
      if (!path) return
      const sourcePaths = get()
        .workspaceImportCandidates.filter((c) => c.kind !== 'unsupported')
        .map((c) => c.sourcePath)
      await window.bearcode.configImport.dismiss(path, sourcePaths)
      set({ workspaceImportBannerVisible: false })
    },
    openImportReview: () => set({ importReviewOpen: true }),
    closeImportReview: () => set({ importReviewOpen: false }),
    applyImportSelection: async (selection) => {
      const path = get().workspacePath
      if (!path) throw new Error('no workspace open')
      const summary = await window.bearcode.configImport.apply(path, selection)
      set({ importReviewOpen: false, workspaceImportBannerVisible: false })
      await get().refreshImportBannerState(path)
      return summary
    },
```

Add `import type { DetectedSource, ImportSelection, ImportSummary } from '@shared/types'` to the file's existing type-only import block.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond the documented 2-error baseline.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/state/store.ts
git commit -m "feat(config-import): wire config-import scan/dismiss/apply into the app store"
```

---

### Task 10: `ImportConfigBanner` component

**Files:**
- Create: `src/renderer/src/components/ImportConfigBanner.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `workspaceImportBannerVisible`, `workspaceImportCandidates`, `dismissImportBanner`, `openImportReview` (store, Task 9)

- [ ] **Step 1: Implement the banner (modeled on `TrustBanner.tsx`)**

```typescript
// src/renderer/src/components/ImportConfigBanner.tsx
import { useAppStore } from '../state/store'

const TOOL_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

export function ImportConfigBanner(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.workspaceImportBannerVisible)
  const candidates = useAppStore((s) => s.workspaceImportCandidates)
  const dismiss = useAppStore((s) => s.dismissImportBanner)
  const openReview = useAppStore((s) => s.openImportReview)
  if (!visible || candidates.length === 0) return null

  const tools = Array.from(new Set(candidates.map((c) => TOOL_LABEL[c.tool] ?? c.tool)))

  return (
    <div className="trust-banner" role="alert">
      <span className="trust-banner-msg">
        This folder has existing agent config from {tools.join(', ')}. Import it into BearCode?
      </span>
      <span className="trust-banner-actions">
        <button className="pill-btn" onClick={() => void dismiss()}>
          Not now
        </button>
        <button className="pill-btn primary" onClick={openReview}>
          Review &amp; Import
        </button>
      </span>
    </div>
  )
}
```

Reuses the existing `.trust-banner`/`.trust-banner-msg`/`.trust-banner-actions` CSS classes rather than introducing new ones — matches `UpdateBanner.tsx`'s documented precedent of reusing that same styling.

- [ ] **Step 2: Mount it in `App.tsx`**

Near `<TrustBanner />` (~line 134):

```typescript
        <TrustBanner />
        <ImportConfigBanner />
```

Add `import { ImportConfigBanner } from './components/ImportConfigBanner'` alongside the existing `TrustBanner` import.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ImportConfigBanner.tsx src/renderer/src/App.tsx
git commit -m "feat(config-import): show a banner when importable external config is detected"
```

---

### Task 11: `ImportConfigReviewModal` component

**Files:**
- Create: `src/renderer/src/components/ImportConfigReviewModal.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `importReviewOpen`, `workspaceImportCandidates`, `closeImportReview`, `applyImportSelection` (store), `useAnimatedUnmount` (`../lib/useAnimatedUnmount`), `EmptyState`/`Loading` (`./ui/EmptyState`, `./ui/Loading`)

- [ ] **Step 1: Implement the modal (modeled on `BrowseSmitheryModal.tsx`)**

```typescript
// src/renderer/src/components/ImportConfigReviewModal.tsx
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { DetectedSource } from '@shared/types'
import { useAppStore } from '../state/store'
import { EmptyState } from './ui/EmptyState'

const KIND_LABEL: Record<DetectedSource['kind'], string> = {
  rule: 'Import as Rule',
  workflow: 'Import as Workflow',
  skill: 'Import as Skill',
  unsupported: 'Not yet supported'
}

interface Props {
  state: 'open' | 'closing'
}

export function ImportConfigReviewModal({ state }: Props): JSX.Element {
  const candidates = useAppStore((s) => s.workspaceImportCandidates)
  const closeReview = useAppStore((s) => s.closeImportReview)
  const applySelection = useAppStore((s) => s.applyImportSelection)
  const importable = candidates.filter((c) => c.kind !== 'unsupported')
  const unsupported = candidates.filter((c) => c.kind === 'unsupported')

  const [selected, setSelected] = useState<Set<string>>(() => new Set(importable.map((c) => c.sourcePath)))
  const [importing, setImporting] = useState(false)
  const [summaryText, setSummaryText] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeReview])

  const toggle = (sourcePath: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourcePath)) next.delete(sourcePath)
      else next.add(sourcePath)
      return next
    })
  }

  const doImport = (): void => {
    setImporting(true)
    const selection = {
      rules: importable.filter((c) => c.kind === 'rule' && selected.has(c.sourcePath)).map((c) => c.sourcePath),
      workflows: importable
        .filter((c) => c.kind === 'workflow' && selected.has(c.sourcePath))
        .map((c) => c.sourcePath),
      skills: importable.filter((c) => c.kind === 'skill' && selected.has(c.sourcePath)).map((c) => c.sourcePath)
    }
    void applySelection(selection).then((summary) => {
      setImporting(false)
      setSummaryText(
        `Imported ${summary.rulesImported} rule(s), ${summary.workflowsImported} workflow(s), ${summary.skillsImported} skill(s).`
      )
    })
  }

  return createPortal(
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && closeReview()}
    >
      <div className="smithery-panel" data-state={state}>
        <div className="smithery-header">
          <div>
            <div className="page-title">Review &amp; Import</div>
            <div className="smithery-sub">
              {summaryText ?? 'Choose what to bring into BearCode.'}
            </div>
          </div>
          <button className="pill-btn" onClick={closeReview}>
            Close
          </button>
        </div>
        {candidates.length === 0 ? (
          <EmptyState title="Nothing detected" />
        ) : (
          <>
            {importable.map((c) => (
              <label key={c.sourcePath} className="set-row">
                <input
                  type="checkbox"
                  checked={selected.has(c.sourcePath)}
                  onChange={() => toggle(c.sourcePath)}
                />
                <div className="set-row-text">
                  <div className="set-row-title">{c.sourcePath}</div>
                  <div className="set-row-desc">{KIND_LABEL[c.kind]}</div>
                </div>
              </label>
            ))}
            {unsupported.map((c) => (
              <div className="set-row" key={c.sourcePath}>
                <div className="set-row-text">
                  <div className="set-row-title">{c.sourcePath}</div>
                  <div className="set-row-desc">{KIND_LABEL[c.kind]}</div>
                </div>
              </div>
            ))}
            <button
              className="pill-btn primary"
              disabled={selected.size === 0 || importing || summaryText !== null}
              onClick={doImport}
            >
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
```

Reuses `.modal-overlay`/`.smithery-panel`/`.smithery-header`/`.smithery-sub`/`.set-row` classes already defined for `BrowseSmitheryModal` rather than introducing new ones. Naming collisions (unique target filenames) are handled server-side by `applyImportSelection` in Task 6 — the review screen does not need to duplicate that logic, only show the resulting summary counts.

- [ ] **Step 2: Mount it in `App.tsx` with `useAnimatedUnmount`**

Near the `TrustBanner`/`ImportConfigBanner` mounts:

```typescript
  const importReviewOpen = useAppStore((s) => s.importReviewOpen)
  const { mounted: importReviewMounted, state: importReviewState } = useAnimatedUnmount(importReviewOpen)
```

```typescript
        {importReviewMounted ? <ImportConfigReviewModal state={importReviewState} /> : null}
```

Add the matching imports (`ImportConfigReviewModal`, and reuse the existing `useAnimatedUnmount` import already present in `App.tsx` for other modals, if one exists — otherwise add `import { useAnimatedUnmount } from './lib/useAnimatedUnmount'`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ImportConfigReviewModal.tsx src/renderer/src/App.tsx
git commit -m "feat(config-import): add the Review & Import modal"
```

---

### Task 12: Manual "scan for importable config" entry point

**Files:**
- Modify: `src/renderer/src/components/Settings/pages/RulesPage.tsx`

**Interfaces:**
- Consumes: `refreshImportBannerState`, `openImportReview` (store, Task 9)

Spec section 2 requires a manual entry point independent of the banner/snooze state ("A manual 'Scan this folder for importable config' action also lives in Settings"). `RulesPage` is the most direct home for it, since every import candidate is either a Rule, Workflow, or Skill.

- [ ] **Step 1: Add the action to `RulesPage.tsx`'s existing page header**

Find `RulesPage`'s top-level header row (styled like `ConnectorsPage`'s `page-title`/`page-sub` block). Add:

```typescript
  const workspacePath = useAppStore((s) => s.workspacePath)
  const refreshImportBannerState = useAppStore((s) => s.refreshImportBannerState)
  const openImportReview = useAppStore((s) => s.openImportReview)
  const [scanning, setScanning] = useState(false)

  const scanForImportableConfig = (): void => {
    setScanning(true)
    void refreshImportBannerState(workspacePath).then(() => {
      setScanning(false)
      openImportReview()
    })
  }
```

```typescript
        <button className="pill-btn" disabled={!workspacePath || scanning} onClick={scanForImportableConfig}>
          {scanning ? 'Scanning…' : 'Scan for importable config…'}
        </button>
```

Add `useState` to the existing React import if not already present, and `useAppStore` if `RulesPage.tsx` doesn't already use the store (check the file's current imports first — if it already reads from `useAppStore`, just add the new selectors to the existing destructure).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Settings/pages/RulesPage.tsx
git commit -m "feat(config-import): add a manual scan-for-importable-config entry point"
```

---

### Task 13: Live smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Build and launch**

Run: `npm run dev` (after killing any stale `electron-vite`/`electron` processes per house convention)

- [ ] **Step 2: Manual walkthrough**

1. Open a scratch folder containing a `CLAUDE.md`, a `.claude/commands/deploy.md`, and a `.claude/skills/pdf-export/SKILL.md` (with a `description:` in frontmatter).
2. Confirm the "This folder has existing agent config…" banner appears.
3. Click "Review & Import", confirm all three items are listed with correct kind labels, uncheck one, click Import.
4. Confirm the summary count matches, and that `.agents/rules/claude.md`, `.agents/workflows/deploy.md` (or `.agents/skills/pdf-export/`, whichever stayed checked) now exist on disk.
5. Reopen the folder (or reload) — confirm the banner does NOT reappear (already imported/dismissed for those sources).
6. Edit the original `CLAUDE.md` on disk, click "Scan for importable config…" (Task 12) and confirm the file no longer reappears as an import candidate (it's already imported) — then verify the actual drift detection via `checkSourceForUpdate`, which is exercised directly through the exposed IPC in the renderer devtools console since no dedicated diff UI exists yet (deferred, see below).

- [ ] **Step 3: Report results to the user**

Summarize what worked and any visual/UX issues found, before considering this plan done.

---

## Deferred to Plan B

- Extending `discoverLocalServers` (`src/main/mcp/store.ts`) with two more origins: `.claude/settings.json`'s `mcpServers` key, and `.cursor/mcp.json` / `.windsurf/mcp.json`.
- Detecting Claude Code hooks (`.claude/settings.json`'s `hooks` key) as "not yet supported," alongside the MCP work above since both read the same file.
- Wiring MCP-server candidates into a shared view with this plan's Rules/Workflows/Skills candidates (or leaving them in the existing Connectors "Import local…" picker — a design call to make when Plan B is scoped).
- A dedicated "Check for updates" diff UI surfaced directly in `RulesPage.tsx`/`SkillsPage.tsx` per imported item (the underlying `checkSourceForUpdate`/`applySourceUpdate`/`ignoreSourceUpdate` logic and IPC are fully built in Tasks 7–8 and usable today via devtools/IPC; only the in-page button + diff view are deferred) — a small follow-up UI task once this plan's core flow is smoke-tested.
