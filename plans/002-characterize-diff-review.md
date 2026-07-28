# Plan 002: Characterize the primary diff-review workflow

> **Executor instructions**: Execute every step and verification in order. Stop on a listed STOP
> condition instead of changing production behavior. Update this plan’s row in `plans/README.md`
> when complete unless the reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/state/store.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: tests
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`DiffPanel` is the pane’s largest and most stateful mode, yet
`ArtifactsPane.test.tsx:106-314` covers attachment and motion lifecycles only. The next plans change
loading, focus, comments, subscriptions, and module boundaries. A black-box characterization suite
must pin the happy path first so those fixes cannot silently alter review behavior.

## Current state

- `ArtifactsPane.tsx:487-832` owns diff fetch, overview/diff modes, file tabs, per-file
  Diff/Code/Preview state, revert/copy/open actions, inline comments, and sending.
- The load begins with `window.bearcode.diffs.get(diffId)` at lines 523-531.
- The current active-file fallback is `files[0]` at lines 541-542.
- `ArtifactsPane.test.tsx:35-59` has a reusable `conversation(id, events)` fixture and lines 88-96
  install a partial typed `window.bearcode`.
- Existing component tests mock heavy Monaco modules rather than rendering real editors; follow
  `FilePreview/FilePreview.test.tsx:6-8`.
- Preserve the approved design constraint: high-frequency target/file/body switching is immediate;
  this plan adds no motion and changes no production code.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx` | all pass |
| Existing pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx` | all pass |
| Typecheck | `npm run typecheck:web` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactsPane.diff.test.tsx` (create)

**Out of scope**:

- Any production file
- The known rejection/focus-race bugs; plans 003 and 004 add failing regression cases for those
- Pixel/CSS assertions or real Monaco

## Git workflow

- Branch: `advisor/002-characterize-diff-review`
- Commit: `test: characterize artifacts diff review`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Build a deterministic diff harness

Create `ArtifactsPane.diff.test.tsx` in jsdom. Mock `MonacoCode`, `MonacoDiff`, and `FilePreview`.
Each Monaco stub must expose its `language`, text, `commentedLines`, and a button that calls
`onAddComment(line, text)` so comments can be exercised without Monaco internals.

Seed a conversation with:

- one preceding `user_message`,
- one `file_diff` event matching the selected `diffId`,
- a resolved `FileDiff` containing a modified TypeScript file and a created PNG file.

Install mocks for `diffs.get/revert/open`, `clipboard.write`, and every API the shell invokes.
Restore store actions and globals after each test, matching `ArtifactsPane.test.tsx`.

**Verify**: run the focused file → it imports and at least one smoke test passes.

### Step 2: Pin loading, default selection, and navigation

Add tests that prove:

1. “Loading changes…” appears until `diffs.get` resolves.
2. The first code file becomes active and renders the diff stub with `typescript`.
3. Overview shows the originating user prompt and both changed-file rows.
4. Clicking a row returns to Diff mode on that exact file.
5. File tabs switch active file; the PNG defaults to Preview while TypeScript defaults to Diff.
6. Diff/Code/Preview choices are remembered independently per file during the mounted session.

Query by accessible button names wherever possible. Assert selected CSS only where no semantic
state exists yet.

**Verify**: focused file → all navigation cases pass.

### Step 3: Pin action and comment behavior that is currently valid

Add cases for:

- Copy writes `afterText` and toasts only after the promise resolves.
- Open calls `diffs.open(fileId)`.
- Revert calls `diffs.revert(fileId)`, marks only that file reverted, and shows the existing toast.
- A Monaco stub can add comments for two files; rows display `basename:line`, deleting one removes
  only it, and `commentedLines` is passed back to the matching editor.

Do not characterize the current premature clear/close behavior after send failure. That is a bug,
not a contract.

**Verify**: focused file → all cases pass with no unhandled promises.

### Step 4: Run regression checks

Run both test files and web typecheck.

**Verify**:

```bash
npx vitest run \
  src/renderer/src/components/ArtifactsPane.diff.test.tsx \
  src/renderer/src/components/ArtifactsPane.test.tsx &&
npm run typecheck:web
```

Expected: exit 0.

## Test plan

The new file is the test plan. It must contain at least eight named cases spanning load, mode
navigation, file navigation, per-file view state, copy/open/revert, and local comment add/remove.
Model async resolution with controllable promises and `act`, not arbitrary timers.

## Done criteria

- [ ] Production source has no diff.
- [ ] At least eight diff-workflow characterization tests pass.
- [ ] Both code and binary/rich default body choices are pinned.
- [ ] Every existing pane test still passes.
- [ ] `npm run typecheck:web` exits 0.
- [ ] `plans/README.md` is updated.

## STOP conditions

- The current happy path is already broken independently of the known load-rejection/focus issues.
- A test requires exposing a new production-only test seam.
- Real Monaco is required for a behavior; defer that assertion to an existing Monaco unit test
  rather than making this component suite brittle.

## Maintenance notes

Keep this suite black-box. Later extraction in plan 014 should require import-path edits at most;
behavior assertions should survive the refactor unchanged.
