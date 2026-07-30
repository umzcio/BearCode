# Plan 017: Split the Artifacts Pane into bounded modules without behavior change

> **Executor instructions**: This is a mechanical extraction after prior behavior plans. Run the
> full characterization suite after every move. No redesign or opportunistic behavior change.
> Update the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactViewer.tsx src/renderer/src/components/ArtifactsPane.css src/renderer/src/components/ArtifactsPane*.test.tsx src/renderer/src/components/artifactsPane`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/002-characterize-diff-review.md`,
  `plans/003-fix-diff-load-focus.md`, `plans/004-preserve-review-drafts.md`,
  `plans/008-isolate-resize-renders.md`, `plans/009-stabilize-artifact-event-projection.md`,
  `plans/011-strengthen-motion-css-contract.md`, `plans/013-centralize-file-classification.md`,
  `plans/014-add-keyboard-review-navigation.md`, `plans/015-surface-browser-readiness.md`, and
  `plans/016-add-artifact-copy-export.md`
- **Category**: tech-debt
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`ArtifactsPane.tsx` is 832 lines and owns shell motion, target synchronization, rail derivation,
attachments, workspace files, diff state, Monaco wiring, comments, browser staging, and headers.
That concentration makes small fixes conflict and hides which state should survive which lifecycle.
After behavior is characterized and corrected, split by lifecycle boundary while preserving one
persistent shell.

## Current state

- `ArtifactsPane` lines 91-142 owns persistent shell, width, exit completion, and browser settlement.
- `ArtifactsPaneInner` lines 156-359 owns target/deep-link/rail selection and routes modes.
- `AttachmentPanel` lines 361-421 owns verified attachment display/save.
- `FilePanel` lines 427-485 owns jailed file load/reveal.
- `DiffPanel` lines 487-832 owns diff review.
- `ArtifactViewer.tsx` is already separate and should remain so.
- The approved design requires:
  - exactly one persistent `.ap-panel` across target changes;
  - no target-switch animation;
  - native browser hide/show sequencing tied to shell settlement;
  - no per-frame renderer-to-main view movement.
- Public imports use `./components/ArtifactsPane`; keep that entry path stable.

## Target module shape

Use sibling modules under `src/renderer/src/components/artifactsPane/`:

- `types.ts` — pane-local view/comment types only;
- `format.ts` — basename/formatBytes and other pure display helpers;
- `PaneHeader.tsx` — `ApBrand` and shared header primitives;
- `AttachmentPanel.tsx`;
- `FilePanel.tsx`;
- `DiffPanel.tsx`;
- `ArtifactsPaneContent.tsx` — target sync, rail, artifact routing.

Keep `components/ArtifactsPane.tsx` as the public shell/export. Adjust names if prior plans already
created equivalent modules; do not duplicate.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Pane suite | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactViewer.test.tsx` | all pass |
| Browser suite | `npx vitest run src/renderer/src/components/Browser/BrowserPane.test.tsx` | all pass |
| Web typecheck | `npm run typecheck:web` | exit 0 |
| Build | `npm run build` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactsPane.tsx`
- New `src/renderer/src/components/artifactsPane/*.tsx|ts`
- Existing pane tests only for import/path adjustments
- `ArtifactsPane.css` only if import ownership changes; no declaration changes

**Out of scope**:

- `ArtifactViewer` behavior/markup
- Store shape/actions
- CSS cleanup or design changes
- Public component name/import changes
- Combining panels into a generic abstraction without two concrete consumers

## Git workflow

- Branch: `advisor/017-split-artifacts-pane-module`
- Prefer one commit per extraction that keeps tests green.
- Final commit message: `refactor: split artifacts pane modules`

## Steps

### Step 1: Capture the post-plan baseline

Run the command table before editing. Record current line count and public exports:

```bash
wc -l src/renderer/src/components/ArtifactsPane.tsx
rg -n "ArtifactsPane" src/renderer/src --glob '*.{ts,tsx}'
```

Expected: all tests pass; only the public import path must remain stable.

### Step 2: Extract pure types/helpers and header

Move only code with no store/lifecycle state first. Add focused pure tests only if prior plans do not
already cover helpers. Re-export nothing unnecessary from the public entry.

**Verify**: pane suite and typecheck pass.

### Step 3: Extract AttachmentPanel and FilePanel

Move each complete component with its own imports. Keep async stale guards and feedback behavior
unchanged. Do not create a generic “loaded panel” abstraction; their trust/data contracts differ.

**Verify** after each move: pane suite passes.

### Step 4: Extract DiffPanel

Move the complete post-fix diff state machine and its types into `DiffPanel.tsx`. Preserve store
selector boundaries from performance plans and keep lazy Monaco imports where bundling behavior
remains equivalent. Do not split internal functions further in this plan unless the file exceeds
450 lines.

**Verify**: characterization, focus/load, drafts, keyboard, classification, and copy/export tests
all pass.

### Step 5: Extract target routing, keep shell public

Move `ArtifactsPaneInner`/rail/artifact routing into `ArtifactsPaneContent.tsx`. Keep
`ArtifactsPane.tsx` responsible only for target/width, animated presence, persistent shell,
transitionend, and browser settled visibility.

Machine boundaries:

- public `ArtifactsPane.tsx` ≤ 180 lines;
- no extracted file > 450 lines;
- exactly one production JSX occurrence of `className...ap-panel`;
- target changes preserve the same shell DOM node.

**Verify**:

```bash
wc -l src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/artifactsPane/*
rg -n "className=.*ap-panel" src/renderer/src/components --glob '*.tsx'
```

Expected: size limits hold; one shell owner.

### Step 6: Run full gate

Run command table, headed browser gate, and `npm test`.

## Test plan

No new behavior tests are expected. Existing suites must run unchanged except import locations.
Add one module-boundary test only if lazy import/export behavior could regress. Compare generated
bundle chunks if moving lazy Monaco imports changes eager loading.

## Done criteria

- [ ] Public import/export stays `components/ArtifactsPane`.
- [ ] One persistent shell owner remains.
- [ ] Module size limits hold.
- [ ] No behavior/CSS/store/API change is mixed in.
- [ ] Full pane, browser, typecheck, build, and test gates pass.
- [ ] Index updated.

## STOP conditions

- Any prerequisite plan is incomplete or its tests are red.
- An extraction changes lazy/eager Monaco bundling materially.
- A circular import appears between public shell and content modules.
- Keeping a module under 450 lines requires a speculative generic abstraction.

## Maintenance notes

Lifecycle ownership is the architecture: shell motion outside, target routing in content, fetch/mutate
state inside each panel. Review diffs for accidental state relocation across those boundaries.
