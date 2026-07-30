# Plan 003: Make diff loading and focus requests race-safe

> **Executor instructions**: Follow the plan in order and run each verification. Update
> `plans/README.md` when done unless the reviewer owns it.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ui/ErrorCard.tsx`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-characterize-diff-review.md`
- **Category**: bug
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

An IPC rejection currently leaves the pane on “Loading changes…” forever. A file-focus deep link
arriving before the diff resolves is marked consumed while `diff` is null, so the requested file is
never selected. Both failures affect the primary review entry points and are deterministic races,
not cosmetic edge cases.

## Current state

At `ArtifactsPane.tsx:523-539`:

```tsx
useEffect(() => {
  let stale = false
  void window.bearcode.diffs.get(diffId).then((d) => {
    if (!stale) setDiff(d)
  })
  return () => { stale = true }
}, [diffId, closeReview])

const [seenFocus, setSeenFocus] = useState<string | null>(null)
if (focusPath && focusPath !== seenFocus) {
  setSeenFocus(focusPath)
  setActiveFileId(diff?.files.find((f) => f.path === focusPath)?.fileId ?? null)
  setMode('diff')
}
```

- There is no `.catch`.
- `seenFocus` is advanced before `diff` exists.
- The UI distinguishes only `diff === null` and `files.length === 0` at lines 672-679 and 755-761.
- `FilePanel` at lines 440-459 is the local exemplar: it has stale-request protection, explicit
  loading reset, and a caught failure state.
- Reuse the shared `ErrorCard` and `Loading` primitives per `CLAUDE.md`; do not create a raw error
  class.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Diff tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx` | all pass |
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx` | all pass |
| Typecheck | `npm run typecheck:web` | exit 0 |
| Lint | `npx eslint src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactsPane.tsx`
- `src/renderer/src/components/ArtifactsPane.diff.test.tsx`

**Out of scope**:

- Comment persistence/sending (plan 004)
- Retry UI, unless it can reuse the same load function without adding another state machine
- Changing `diffs.get` IPC or database behavior
- Motion or layout changes

## Git workflow

- Branch: `advisor/003-fix-diff-load-focus`
- Commit: `fix: make diff review loading race-safe`

## Steps

### Step 1: Add failing regression cases

Add tests for:

1. `diffs.get` rejection replaces loading with an accessible error and never shows “No changes”.
2. A focus path present before the deferred `diffs.get` resolution selects the matching non-first
   file after resolution and switches to Diff mode.
3. Resolving an older request after the selected diff changes cannot overwrite the new diff.
4. A resolved empty diff shows “No changes”, preserving the distinction from error/loading.

**Verify**: run the focused test before production edits → the first two cases fail for the expected
reasons.

### Step 2: Replace nullable data with an explicit load state

In `DiffPanel`, represent `loading`, `ready`, and `error` explicitly. Include `diffId` in the state
or derive currentness so a previous payload is never rendered for a new id. On each effect run,
enter loading; on resolve enter ready; on reject enter error; ignore all stale completions.

Remove `closeReview` from the load effect dependency because it does not participate in the fetch.
Use a stable local `loadDiff` callback only if retry is added.

Render:

- `Loading label="Loading changes…"` for loading,
- `ErrorCard` with concise copy such as “Could not load changes” for error,
- `EmptyState title="No changes"` only for a ready diff with zero files.

**Verify**: rejection/empty/stale tests pass.

### Step 3: Consume focus only after a ready payload can resolve it

Move focus handling into an effect or another commit-safe synchronization path depending on
`focusPath` and the ready diff. Do not set state during render. Advance `seenFocus` only after the
ready file list has been searched. If the path is absent in a ready diff, consume it once and keep
the normal first-file fallback; do not loop every render.

The exact match remains full `f.path === focusPath`; do not add basename matching.

**Verify**: the deferred-focus test selects the requested file, and an unknown path falls back
without a render loop.

### Step 4: Run the gate

Run all commands in the table.

## Test plan

Model deferred promises with captured resolvers. Cover reject, stale resolve, focused path found,
focused path missing, and ready-empty. Preserve all characterization tests from plan 002.

## Done criteria

- [ ] Every `diffs.get` path reaches loading, ready, or error.
- [ ] No rejected promise is unhandled.
- [ ] A pre-load focus request selects the correct file after resolution.
- [ ] Stale results cannot replace current data.
- [ ] “No changes” is shown only after a successful empty load.
- [ ] Focused tests, web typecheck, and scoped lint pass.
- [ ] `plans/README.md` is updated.

## STOP conditions

- The focus path is intentionally cleared elsewhere before the diff load completes.
- A fix requires changing the public preload API.
- React reports a render loop or set-state-during-render warning after the change.

## Maintenance notes

Any future retry action must reuse the same request-generation/stale guard. Reviewers should pay
special attention to a rejected old request arriving after a newer successful one.
