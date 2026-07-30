# Plan 005: Clear artifact comment drafts only after insertion succeeds

> **Executor instructions**: Follow all steps and verification gates. Update the README status row
> when complete.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactViewer.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/renderer/src/state/store.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: bug
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

Artifact comment text is cleared immediately after a fire-and-forget insertion. If SQLite/IPC or
the following comment refresh rejects, the user loses the quote and draft with no feedback. The
store already exposes an awaitable mutation, so the viewer should honor it.

## Current state

`ArtifactViewer.tsx:148-153` currently:

```tsx
void addArtifactComment(selected.artifactId, draftQuote, draftBody.trim())
setDraftQuote(null)
setDraftBody('')
```

- `store.ts:1783-1785` correctly awaits both `artifacts.addComment` and
  `loadArtifactComments`; rejection propagates.
- The viewer already has the `resolving` pattern at lines 160-185: guard duplicate actions, await,
  clear only on success, and retain editable state on failure.
- The Add comment button is at lines 262-268 and currently disables only for an empty body.
- User-facing errors should go through store `showToast` and `describeError` where appropriate.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `npx vitest run src/renderer/src/components/ArtifactViewer.test.tsx` | all pass |
| Typecheck | `npm run typecheck:web` | exit 0 |
| Lint | `npx eslint src/renderer/src/components/ArtifactViewer.tsx src/renderer/src/components/ArtifactViewer.test.tsx` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactViewer.tsx`
- `src/renderer/src/components/ArtifactViewer.test.tsx`

**Out of scope**:

- Store/database mutation semantics
- Plan resolution behavior
- Persisting the not-yet-added textarea draft across artifact navigation
- Changing comment copy or markup

## Git workflow

- Branch: `advisor/005-preserve-artifact-comment-draft`
- Commit: `fix: preserve artifact comment on insert failure`

## Steps

### Step 1: Add regression tests

Extend `ArtifactViewer.test.tsx` with a helper that creates a text selection inside the rendered
artifact body and opens the composer. Add cases for:

- pending insertion disables Add comment and blocks a duplicate click;
- successful insertion clears the composer after the promise resolves;
- rejected insertion keeps quote and body editable and shows an error toast;
- changing artifact while insertion is pending prevents the old completion from clearing the new
  artifact’s state.

Use controllable promises and `act`; do not use arbitrary sleeps.

**Verify**: failure and pending cases fail before production changes.

### Step 2: Await insertion and guard stale completions

Make `submitDraft` async, add an insertion-pending flag and a generation/artifact-id guard similar
to `resolutionRun`. Snapshot artifact id, quote, and trimmed body. Await `addArtifactComment`; clear
only if it succeeds and the selected artifact/generation is still current. On failure, leave both
fields untouched and show one concise failure toast. Always release pending state for the current
generation.

Disable both Add and Cancel while insertion is pending, or make Cancel invalidate the generation;
do not allow a late resolve to clear state the user has since changed.

**Verify**: all new cases pass.

### Step 3: Run checks

Run all commands in the table.

## Test plan

The regression suite must assert exact draft values before and after promise settlement, not just
composer presence. Assert `addArtifactComment` receives the selected artifact id, quote, and trimmed
body exactly once.

## Done criteria

- [ ] Insert is awaited.
- [ ] Draft clears only after success for the same artifact/run.
- [ ] Failure retains exact quote/body and shows no false success.
- [ ] Duplicate insertion is impossible while pending.
- [ ] Tests, web typecheck, and scoped lint pass.
- [ ] README status updated.

## STOP conditions

- `addArtifactComment` no longer returns a promise.
- The test cannot create a selection without changing production markup.
- A pending insertion can be committed to a different artifact id by the main process.

## Maintenance notes

Keep this guard separate from `resolutionRun`; comment insertion and plan resolution are independent
mutations and may overlap.
