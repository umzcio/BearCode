# Plan 001: Restore a zero-baseline typecheck, lint, and test gate

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan’s row in
> `plans/README.md` unless a reviewer says they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- package.json package-lock.json eslint.config.mjs CLAUDE.md src/main/artifacts/store.test.ts src/main/docgen/generate.test.ts src/main/memory/index.test.ts src/main/orchestrator/graph.test.ts src/main/orchestrator/graph.ts src/main/orchestrator/resume.test.ts src/main/permissions/index.test.ts src/main/permissions/store.test.ts src/main/voice/transcribe.test.ts src/main/voice/transcribe.ts src/renderer/src/components/Composer/useVoiceRecorder.test.tsx src/renderer/src/components/Settings/pages/PermissionsPage.tsx`
> If an in-scope file changed, compare the current-state facts below with live code before editing.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The documented merge gate is not enforceable: both TypeScript projects fail, ESLint crashes before
parsing a file, and the full suite reads the developer’s real global memory and fails when it is not
empty. Every later Artifacts Pane change would therefore have to distinguish regressions from a
moving baseline. This plan restores a literal zero-error gate and updates the documentation so
future executors do not normalize known failures.

## Current state

- `package.json:12-15` defines `lint`, `typecheck:node`, `typecheck:web`, and `typecheck`.
- `package.json:85` requests `typescript: ^7.0.2`.
- `package-lock.json:704-707` records the installed `typescript-eslint` peer range as
  `typescript >=4.8.4 <6.1.0`. Running scoped ESLint currently exits 2 with
  `Cannot read properties of undefined (reading 'Cjs')`.
- `npm run typecheck:node` currently reports 14 errors. They are concentrated in incomplete
  `AppSettings`/`ConversationMeta` test fixtures, one optional compaction marker,
  Node/Web `Buffer` compatibility, and incorrectly inferred zero-argument Vitest mocks.
- `npm run typecheck:web` reports exactly:

```text
src/renderer/src/components/Composer/useVoiceRecorder.test.tsx(67,37): TS2493
src/renderer/src/components/Settings/pages/PermissionsPage.tsx(179,13): TS2322
```

- `src/main/settings.ts:35-91` is the exhaustive production `AppSettings` default object. Prefer a
  single typed test factory over repeating that object across tests.
- `src/main/memory/index.test.ts:67-73` assumes the user’s global memory is empty, although
  `listMemory()` intentionally includes the real global scope.
- `CLAUDE.md:31-39` says the acceptable baseline is 17 node and 2 web errors. Replace this with a
  zero-baseline rule after the gate passes.
- Commit messages use short conventional prefixes such as
  `fix: reject malformed motion tokens`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Re-resolve toolchain | `npm install --save-dev typescript@~6.0.0` | exit 0; lockfile updated |
| Node types | `npm run typecheck:node` | exit 0, no errors |
| Web types | `npm run typecheck:web` | exit 0, no errors |
| Scoped lint | `npx eslint src/main src/renderer/src/components/ArtifactsPane.tsx` | exit 0 |
| Tests | `npm test` | all test files pass |
| Build | `npm run build` | exit 0 |

Do not run a broad lint auto-fix. `CLAUDE.md` explicitly permits only
`npx eslint --fix <specific paths>`.

## Scope

**In scope**:

- `package.json`, `package-lock.json`, `CLAUDE.md`
- `src/main/test/fixtures.ts` (create if a shared typed fixture is needed)
- `src/main/artifacts/store.test.ts`
- `src/main/docgen/generate.test.ts`
- `src/main/memory/index.test.ts`
- `src/main/orchestrator/graph.test.ts`
- `src/main/orchestrator/graph.ts`
- `src/main/orchestrator/resume.test.ts`
- `src/main/permissions/index.test.ts`
- `src/main/permissions/store.test.ts`
- `src/main/voice/transcribe.test.ts`
- `src/main/voice/transcribe.ts`
- `src/renderer/src/components/Composer/useVoiceRecorder.test.tsx`
- `src/renderer/src/components/Settings/pages/PermissionsPage.tsx`

**Out of scope**:

- Product behavior changes unrelated to making the current types explicit
- Disabling strictness, excluding tests from tsconfig, adding `skipLibCheck`, or suppressing errors
  with unreasoned casts
- Upgrading to a parser line whose published peer range still excludes the selected TypeScript
- Formatting or lint-fixing the whole repository

## Git workflow

- Branch: `advisor/001-restore-static-gate`
- Make one toolchain commit and one source/test cleanup commit if practical.
- Suggested final message: `fix: restore zero-baseline static gate`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Put TypeScript inside the parser’s supported range

Run `npm install --save-dev typescript@~6.0.0`. Confirm `package.json` no longer requests TypeScript
7 and the lockfile resolves a version satisfying `<6.1.0`. Do not use `--legacy-peer-deps`.

**Verify**:

```bash
npm ls typescript typescript-eslint @typescript-eslint/parser
npx eslint src/renderer/src/components/ArtifactsPane.tsx
```

Expected: both commands exit 0; npm reports no invalid peer dependency and ESLint does not throw
the `Cjs` exception.

### Step 2: Re-baseline the actual compiler output after the compatible install

Run both typechecks and save the exact remaining file list. Some Buffer errors may disappear under
TypeScript 6; fix what remains, not the obsolete pre-downgrade list.

Use these target shapes:

- Put exhaustive `AppSettings` and `ConversationMeta` factories in
  `src/main/test/fixtures.ts` if three or more tests need the same shape. The factories must accept
  `Partial<T>` overrides and return a complete `T`; tests should not use `as T`.
- At `graph.ts:3634`, narrow `_summarizationEvent` by checking that `cutoffIndex` is a finite number
  before passing `{ cutoffIndex }` to `compactionAdvanced`.
- For `Buffer`/`BlobPart`, pass an owned `Uint8Array`/`ArrayBuffer` with the correct generic rather
  than casting away `SharedArrayBuffer`.
- Type `vi.fn` declarations with their call signature so `mock.calls[0][N]` has a real tuple.
- In `PermissionsPage.tsx`, use the existing selectable-default guard/type from
  `src/shared/permissionMode.ts`; never admit `bypass` to the default-mode `Select`.

**Verify**: `npm run typecheck` → exit 0, no diagnostics.

### Step 3: Make the full suite independent of personal global memory

Change `src/main/memory/index.test.ts` so “returns both scopes with sizes” verifies the project
entries it created and verifies the global result against the same global loader source (or only
its shape/size), rather than asserting the machine-global list is empty. Do not delete or overwrite
global memory in the test.

**Verify**:

```bash
npx vitest run src/main/memory/index.test.ts
```

Expected: 12 tests pass even when the developer already has global memory entries.

### Step 4: Replace the documented nonzero baseline

In `CLAUDE.md`, change the gate language to require zero errors from both typechecks, scoped lint
for changed files, and a passing full Vitest run. Preserve the warning against broad `--fix`.

**Verify**:

```bash
rg -n "17 node|2 web|not regressions" CLAUDE.md
```

Expected: no matches.

### Step 5: Run the complete gate

Run the commands in the table. If lint reports genuine existing findings after the parser starts,
fix only findings in files already touched by this plan; report unrelated findings rather than
running a repository-wide auto-fix.

**Verify**: `npm run typecheck && npm test && npm run build` → every command exits 0.

## Test plan

- Existing compiler projects are the regression test for every fixture/type correction.
- `src/main/memory/index.test.ts` must pass with both an empty and non-empty real global scope.
- Add a narrow test for any new type guard that contains runtime behavior.
- Do not add snapshot tests for compiler output.

## Done criteria

- [ ] `npm ls` shows TypeScript inside the parser’s declared peer range.
- [ ] Scoped ESLint exits 0 and does not crash.
- [ ] `npm run typecheck` exits 0 with no baseline allowance.
- [ ] `npm test` exits 0; the memory test is machine-independent.
- [ ] `npm run build` exits 0.
- [ ] `CLAUDE.md` documents a zero-error gate.
- [ ] No product feature behavior changed.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- The compatible TypeScript line causes more than 30 new source errors or requires disabling a
  strict compiler option.
- A remaining error can only be removed by changing a public wire shape.
- `npm install` resolves a parser whose peer range still excludes the installed compiler.
- A test fix would read, write, or delete the user’s real global memory.

## Maintenance notes

Keep shared test factories exhaustive: a future required field should break one factory rather than
dozens of partial literals. Reviewers should reject any reintroduction of a documented nonzero
baseline; a red gate is a task, not a convention.
