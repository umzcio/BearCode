# Plan 004: Preserve review drafts until a run is accepted

> **Executor instructions**: Execute in order, verify each step, and stop on listed conditions.
> Update the index row on completion.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/Composer/Composer.tsx src/renderer/src/components/ConversationView.tsx src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-characterize-diff-review.md`
- **Category**: bug
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

Diff comments live inside a keyed `DiffPanel`, so rail navigation destroys them. Sending is
fire-and-forget: the pane clears comments, toasts success, and closes even when no model is selected
or `run.start` rejects. Review text is user-authored data; it must survive navigation and be removed
only after main accepts the run.

## Current state

At `ArtifactsPane.tsx:507,570-577`:

```tsx
const [comments, setComments] = useState<ReviewComment[]>([])
send(convoId, message)
setComments([])
showToast(...)
closeReview()
```

- `ArtifactsPaneInner` renders `<DiffPanel key={resolved.diffId}>`; switching deliverables unmounts
  the component.
- `store.ts:1195-1211` declares `send(...): void`, silently returns when `modelRef` is null, and
  starts the run with `void window.bearcode.run.start(...)` without a rejection handler.
- `Composer.tsx:413-425` clears its text before invoking `onSend`, so making `send` honest requires
  updating this caller too.
- Store rejection precedent: `deletePermissionRule` at `store.ts:1248-1257` awaits the mutation,
  refreshes/repairs state, and rethrows.
- Human-facing caught errors use `describeError` from `src/renderer/src/lib/errors.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Store tests | `npx vitest run src/renderer/src/state/store.test.ts` | all pass |
| Diff tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx` | all pass |
| Composer tests | `npx vitest run src/renderer/src/components/Composer/Composer.test.tsx` | all pass |
| Web gate | `npm run typecheck:web` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/state/store.ts`
- `src/renderer/src/state/store.test.ts`
- `src/renderer/src/components/ArtifactsPane.tsx`
- `src/renderer/src/components/ArtifactsPane.diff.test.tsx`
- `src/renderer/src/components/Composer/Composer.tsx`
- Its closest existing test file if the async submit behavior needs a regression case
- `src/renderer/src/components/ConversationView.tsx`

**Out of scope**:

- Persisting diff comments across application restarts
- Changing the generated review message format
- Artifact-plan comments (plan 005)
- Main-process run orchestration

## Git workflow

- Branch: `advisor/004-preserve-review-drafts`
- Commit: `fix: preserve review drafts until send succeeds`

## Steps

### Step 1: Make run dispatch return an honest result

Change `AppState.send` to return `Promise<boolean>`. It returns `false` without calling IPC when
there is no model or conversation. It awaits `run.start`; on success it returns `true`. On rejection
it shows `describeError(error)` and returns `false` (or rethrows if all callers explicitly catch;
choose one contract and test it). Keep focus-reset and model patch ordering consistent with the
accepted run; do not display success in the store.

Update `ConversationView` and `Composer` so a submit is guarded while pending and the composer clears
only after `onSend` resolves true. Preserve text, command, mentions, and attachments on false.
Existing synchronous call sites may use `void send(...)`.

**Verify**: store tests cover no-model, accepted, and rejected start; no unhandled rejection occurs.

### Step 2: Move diff comments to session-level store state

Define/export the review-comment type near `AppState`, add
`diffReviewComments: Record<string, ReviewComment[]>`, and add narrowly named actions to add, remove,
and clear a diff’s comments. Use stable IDs per diff; deleting one comment must not renumber others.

`DiffPanel` reads `diffReviewComments[diffId] ?? []` and uses store actions. Do not clear on unmount,
rail navigation, pane close, file switch, or body-view switch. Clear only after accepted send.

Prune a diff’s comments after successful send. Do not add persistence/IPC.

**Verify**: a component test adds a comment, switches to an artifact/other diff and back, and finds
the draft unchanged.

### Step 3: Make send transactional in `DiffPanel`

Add a `sending` guard. On click:

1. Snapshot the current comments.
2. Await `send(convoId, formattedMessage)`.
3. If false, keep the exact drafts visible, keep the pane open, and show no success toast.
4. If true, clear that diff’s comments, show the existing singular/plural toast, and close.

Disable the send button while awaiting. If comments change while the await is pending, clear only
the snapshotted IDs after success so newly added drafts cannot be lost.

**Verify**: deferred resolve, rejection/false, duplicate click, and “new comment during pending
send” cases pass.

### Step 4: Run focused and full web checks

Run commands in the table, then:

```bash
npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx
```

Expected: all pass.

## Test plan

- Store: no model → false/no IPC; accepted → true; rejected → false plus one error toast.
- Composer: failed dispatch preserves all draft fields; pending dispatch blocks duplicate submit.
- Diff: rail/close/reopen session preservation, failed send preservation, success-only clear/close,
  duplicate prevention, comments added during pending are retained.
- Keep the exact formatted message assertion from the characterization harness.

## Done criteria

- [ ] `send` has a tested asynchronous success contract.
- [ ] No user-authored draft clears before accepted IPC.
- [ ] Diff drafts survive keyed panel unmounts during the app session.
- [ ] Failure never produces a success toast or closes the pane.
- [ ] Duplicate sends are blocked.
- [ ] Newly added pending-period comments are not lost.
- [ ] Focused tests, web typecheck, and scoped lint pass.
- [ ] Index row updated.

## STOP conditions

- Main’s `run.start` resolves before it has actually accepted ownership of the run.
- Making `Composer.onSend` asynchronous breaks a second undocumented caller.
- Draft persistence requires serialization or schema migration.
- A test exposes pre-existing composer data loss beyond dispatch failure; report it separately.

## Maintenance notes

The returned boolean means “main accepted dispatch”, not “the agent finished successfully.” Keep
that distinction explicit. Reviewers should scrutinize snapshot clearing and late comment races.
