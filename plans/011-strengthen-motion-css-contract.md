# Plan 011: Strengthen the motion CSS contract and remove dead pane CSS

> **Executor instructions**: Add behavioral contract coverage before deletion. Remove only selectors
> proven unused. Update the index when complete.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/main/artifactsPaneMotionContract.test.ts src/renderer/src/components/ArtifactsPane.css src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactViewer.tsx`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: tech-debt
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The current contract checks that selector names and declaration fragments occur somewhere in a
1,380-line stylesheet. It can pass even if a pressable family is not inside the shared rule or a
reduced-motion override targets the wrong block. The same file contains large obsolete families
from pre-redesign pane markup, making future motion edits harder to review.

## Current state

- `artifactsPaneMotionContract.test.ts:9-35` loops selector strings with
  `expect(paneCss).toContain(selector)`, then checks declarations independently.
- The approved contract requires every pressable family in the shared base/active/reduced blocks,
  no disabled scale, and both OS/in-app positional-motion removal.
- Searches outside CSS return no references for these obsolete families:
  - `.panel-close`, `.turn-chip*`, `.head-icon`;
  - `.file-section*`, `.mini-btn`, `.overview-body`, `.crumb-*`;
  - `.comment-overlay`, `.comment-zone` (not `.comment-zone-inline`), `.comment-actions`,
    `.comment-spacer`, `.comment-mic`, `.comment-cancel`, `.comment-add`;
  - `.artifact-pane-head`, `.artifact-rail`, `.artifact-rail-item`, `.artifact-rail-title`,
    `.artifact-rail-meta`.
- Live modern selectors include `.ap-*`, `.overview-*`, `.comment-zone-inline`, `.comment-bar*`,
  `.artifact-view*`, `.artifact-version-history`, and `.version-chip`.
- Do not violate the design’s deliberate exception: Monaco view-zone height is allowed because it
  prevents code occlusion; CSS surface motion remains transform/opacity.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Contract | `npx vitest run src/main/artifactsPaneMotionContract.test.ts` | all pass |
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/components/ArtifactViewer.test.tsx` | all pass |
| Dead selector scan | see Step 3 | no obsolete class references |
| Build | `npm run build` | exit 0 |

## Scope

**In scope**:

- `src/main/artifactsPaneMotionContract.test.ts`
- `src/renderer/src/components/ArtifactsPane.css`

**Out of scope**:

- Visual redesign or token changes
- Renaming live classes
- Adding a CSS parser dependency
- Removing a selector with any live TSX/DOM-generated reference
- CSS outside the Artifacts Pane

## Git workflow

- Branch: `advisor/011-strengthen-motion-css-contract`
- Commit: `test: enforce artifacts motion css contract`

## Steps

### Step 1: Make contract assertions rule-aware

In the test, add a small deterministic helper that extracts a selector prelude and declaration body
with balanced braces (including nested `@media`/`@starting-style`). Normalize whitespace only for
comparison. Do not use loose whole-file regexes that can cross unrelated rule boundaries.

Assert:

- every pressable family is present inside the base shared `:is(...)` rule;
- every pressable family is present inside the active rule;
- applicable button families are in the disabled no-transform rule;
- every pressable family is covered in both OS and in-app reduced-motion active overrides;
- base and active rules contain their correct duration tokens;
- no `transition: all`, `scale(0)`, or hardcoded motion duration appears in live pane rules;
- panel/comment/status reduced-motion declarations belong to their respective nested blocks.

**Verify**: mutate an in-memory CSS string in one unit case to remove a family from the shared rule;
the helper must fail that case even if the selector still appears elsewhere.

### Step 2: Prove the candidate selectors are dead

Before deletion, run:

```bash
rg -n \
  "panel-close|turn-chip|head-icon|file-section|mini-btn|overview-body|crumb-part|crumb-sep|crumb-file|comment-overlay|comment-actions|comment-spacer|comment-mic|comment-cancel|comment-add|artifact-pane-head|artifact-rail" \
  src/renderer/src --glob '!**/ArtifactsPane.css'
```

Expected: no matches, except any explicitly investigated substring collision. Separately confirm
`.comment-zone-inline` remains live.

### Step 3: Delete obsolete rule families only

Remove the proven-dead blocks and their comments. Do not remove shared live rules such as
`.ap-scroll`, `.monaco-host`, `.diff-loading`, overview titles/files, comment list/rows, or artifact
viewer rules merely because they predate the redesign.

After deletion:

```bash
rg -n \
  "^\\.(panel-close|turn-chip|head-icon|file-section|mini-btn|overview-body|crumb-|comment-overlay|comment-zone[ {]|comment-actions|comment-spacer|comment-mic|comment-cancel|comment-add|artifact-pane-head|artifact-rail)" \
  src/renderer/src/components/ArtifactsPane.css
```

Expected: no matches. `.comment-zone-inline` must still match its own separate check.

### Step 4: Run contract, UI, and build checks

Run commands in the table and scoped lint on the test.

## Test plan

The rule extractor gets its own cases for nested at-rules and selector whitespace. The production
contract must fail when a family is moved outside a shared block, not merely deleted from the file.
Existing pane tests protect markup after CSS deletion.

## Done criteria

- [ ] Contract assertions bind selectors to exact rule bodies.
- [ ] OS and in-app reduced paths cover every movement family.
- [ ] Every deleted selector was proven unused outside CSS.
- [ ] Live comment/overview/artifact styling remains.
- [ ] Contract, pane tests, typecheck, and build pass.
- [ ] Index updated.

## STOP conditions

- A candidate class is generated dynamically outside the searched source.
- The rule helper cannot distinguish nested reduced-motion blocks without becoming a partial,
  unreliable CSS parser.
- Visual smoke shows a live surface lost styling; restore that block and report the missed usage.

## Maintenance notes

When adding a new pressable family, the contract should fail until all base/active/disabled/reduced
blocks are updated. Keep the selector list the single review checklist.
