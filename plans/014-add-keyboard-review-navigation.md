# Plan 014: Add semantic keyboard navigation to Artifacts review controls

> **Executor instructions**: Implement the recommended focus-scoped tab behavior below. Do not add
> global letter shortcuts. Run accessibility-focused tests and update the plan index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactsPane.css src/renderer/src/components/ui/Menu.tsx`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-characterize-diff-review.md`, `plans/003-fix-diff-load-focus.md`
- **Category**: direction
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

Rail entries, mode toggles, and file tabs are buttons that can be reached only by repeated Tab
presses; arrow keys, Home, and End do nothing, and assistive technology receives no selected-tab
semantics. A review surface should let keyboard users enter a group once and move/activate within
it. Focus-scoped tablists provide that without stealing Monaco or textarea keystrokes.

## Current state

- Deliverable rail buttons render at `ArtifactsPane.tsx:249-306`.
- Overview/Diff buttons render at lines 597-607; file tabs at 685-727; Diff/Code/Preview at 729-750.
- The only pane-level shortcut is Escape at lines 187-200, guarded for INPUT/TEXTAREA.
- `components/ui/Menu.tsx:95-135` is the local roving-navigation exemplar: wrapping step,
  disabled-item skip, Home/End, preventDefault, and commit.
- The approved motion design says high-frequency selection changes remain immediate. Keyboard
  activation must not add selection animation.

## Recommended interaction

Treat each rail/toggle/tab group as an automatically activated horizontal tablist:

- only the selected tab is in the page Tab order (`tabIndex=0`; others `-1`);
- ArrowRight/ArrowLeft wrap, focus, and activate the adjacent enabled tab;
- Home/End focus and activate first/last;
- clicking still activates normally;
- selected changes scroll the focused tab into view with `{ block: 'nearest', inline: 'nearest' }`;
- handlers are attached to the tablist/buttons only—never `window`—so Monaco, feedback textareas,
  and comment inputs retain all arrow keys;
- Escape behavior is unchanged.

Do not add bare `j/k`, Cmd+[ / Cmd+], or other global shortcuts in this plan.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Diff keyboard tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx` | all pass |
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx` | all pass |
| Typecheck | `npm run typecheck:web` | exit 0 |
| Lint | `npx eslint src/renderer/src/components/ArtifactsPane.tsx` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactsPane.tsx`
- `src/renderer/src/components/ArtifactsPane.diff.test.tsx`
- `src/renderer/src/components/ArtifactsPane.test.tsx`
- `src/renderer/src/lib/useRovingTabs.ts` and test (create if abstraction is justified)
- `ArtifactsPane.css` only for focus-visible/semantic selector adjustments

**Out of scope**:

- App-global shortcuts
- Focus trapping inside the pane
- Changing Escape, Monaco, or textarea key handling
- New visual layout or selection motion

## Git workflow

- Branch: `advisor/014-add-keyboard-review-navigation`
- Commit: `feat: add keyboard artifacts navigation`

## Steps

### Step 1: Add accessibility regressions

For rail, file tabs, and both segmented groups, assert:

- container has `role="tablist"` and an accessible label;
- buttons have `role="tab"`, `aria-selected`, selected-only `tabIndex=0`;
- Arrow keys wrap and immediately change both focus and selected content;
- Home/End work;
- a keydown inside a Monaco/comment/feedback textarea does not change selection;
- mouse clicks preserve correct tabIndex/ARIA state.

Stub `scrollIntoView` and assert it is called only for keyboard focus moves.

**Verify**: semantic/arrow cases fail before implementation.

### Step 2: Implement one reusable horizontal-tab behavior

Create a small hook/helper only if it removes duplicated stepping/focus code across at least three
groups. It should accept ordered IDs, current ID, and an activation callback. It must query/focus
within the current tablist ref, not the whole document, because multiple groups coexist.

Use stable DOM IDs for `aria-controls`/tabpanel links where practical. If a segmented choice does
not map cleanly to a separate panel, still provide selected tab semantics and a labeled owning
region; do not invent invalid `aria-controls`.

**Verify**: all keyboard cases pass.

### Step 3: Preserve focus visuals and motion constraints

Use existing focus tokens/`:focus-visible`. Never add `outline: none` without replacement. No
transform or content transition is added when arrows switch a target.

**Verify**:

```bash
rg -n "outline:\\s*none|transition:\\s*all" src/renderer/src/components/ArtifactsPane.css
```

Expected: no newly introduced violation.

### Step 4: Run checks

Run the command table and plan 002 characterization tests.

## Test plan

Cover every group, wrap, Home/End, click-to-roving-state sync, and editable-target noninterference.
Use accessibility queries rather than CSS classes for semantics.

## Done criteria

- [ ] Rail, file, and mode groups expose selected-tab semantics.
- [ ] One Tab enters each group; arrows/Home/End navigate and activate.
- [ ] Focus never escapes to another group accidentally.
- [ ] Monaco and text inputs retain arrow keys.
- [ ] No target-switch animation was added.
- [ ] Tests/typecheck/lint pass; index updated.

## STOP conditions

- An automatically activated tab causes expensive async work on focus that should require Enter.
  If so, stop and propose manual activation for that group only.
- A group cannot be represented as tabs without misleading accessibility semantics.
- Focus changes remount Monaco and lose editor state beyond existing click behavior.

## Maintenance notes

Future rail/file controls should join the ordered tab model. Keep keyboard handlers local; global
shortcuts need a separate conflict/discoverability design.
