# Plan 013: Share file-extension and Monaco-language classification

> **Executor instructions**: Preserve every current classification decision while moving the shared
> facts. Run the matrix tests before changing callers. Update the index on completion.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/main/preview/classify.ts src/main/preview/classify.test.ts src/shared`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: tech-debt
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The renderer and main process maintain different language maps. Ruby, Go, Rust, Java, Kotlin, C/C++,
C#, PHP, Swift, TOML, SCSS, and others render as plaintext in diff review even though preview
classification knows their Monaco IDs. Centralizing process-neutral extension facts prevents future
drift while preserving main’s richer preview-kind decisions.

## Current state

- `ArtifactsPane.tsx:24-46` defines a 19-entry `LANG_BY_EXT` and local `languageFor`.
- `ArtifactsPane.tsx:69-75` separately defines `isBinaryPreview` for the default body choice.
- `main/preview/classify.ts:1-38` explicitly says its larger language map duplicates the renderer
  because main cannot import renderer code.
- Both processes can import `src/shared` through existing aliases/relative imports. Shared modules
  such as `src/shared/permissionMode.ts` already hold pure enum guards consumed on both sides.
- Preserve current preview semantics:
  - image/svg/pdf/docx/xlsx default to rendered Preview in diff review;
  - HTML/Markdown/CSV/JSON/code/text default to reviewable source;
  - main still returns its existing `PreviewKind` values.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Shared tests | `npx vitest run src/shared/fileClassification.test.ts` | all pass |
| Main tests | `npx vitest run src/main/preview/classify.test.ts` | all pass |
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx` | all pass |
| Types | `npm run typecheck` | exit 0 |

## Scope

**In scope**:

- `src/shared/fileClassification.ts` and `.test.ts` (create)
- `src/main/preview/classify.ts` and `.test.ts`
- `src/renderer/src/components/ArtifactsPane.tsx`
- Diff characterization tests for language/default-view matrix

**Out of scope**:

- MIME sniffing or content-based classification
- Preview rendering implementation
- Changing which formats default to source versus rendered preview
- Moving Electron-only preview logic into shared

## Git workflow

- Branch: `advisor/013-centralize-file-classification`
- Commit: `refactor: share artifacts file classification`

## Steps

### Step 1: Pin the cross-process matrix

Create table-driven shared tests for lowercase/uppercase extensions, no extension, dotfiles, and all
currently mapped languages. Add renderer characterization cases for at least Ruby/Go/Rust becoming
their correct Monaco languages while keeping PNG/SVG rendered-preview defaults and HTML/Markdown
source defaults.

The new correct language behavior is intentional; write those cases failing before the caller move.

### Step 2: Create a pure shared vocabulary

Export narrowly named helpers/constants:

- extension extraction with lowercase normalization;
- `languageForPath(path): string` with `plaintext` fallback;
- a predicate named for behavior, e.g. `defaultsToRenderedPreview(path)`, not “binary” (SVG is text);
- optionally the readonly language map if main needs its keys.

Keep the mapping immutable/read-only. Include every entry from the main-process superset and
renderer-specific HTML/JSON/Markdown entries.

**Verify**: shared tests pass.

### Step 3: Rewire main and renderer

Make `previewClassify` import the shared extension/language facts while retaining PreviewKind
branch ordering locally. Remove both renderer-local maps/predicates and the stale duplication
comment. Use the shared helpers in FilePanel and DiffPanel.

**Verify**: main and pane matrix tests pass with no changed preview kinds/default body choices.

### Step 4: Run checks

Run all commands in the table and scoped lint.

## Test plan

One shared table owns extensions/languages. Main tests own PreviewKind precedence. Renderer tests own
default body view and Monaco language. Include `.bashrc`/extensionless fallback so dot handling is
explicit.

## Done criteria

- [ ] Exactly one language map remains.
- [ ] Main and renderer import shared pure helpers.
- [ ] Existing preview-kind/default-view behavior is unchanged.
- [ ] Previously omitted language extensions render with correct Monaco IDs.
- [ ] Matrix tests and both typechecks pass.
- [ ] README row updated.

## STOP conditions

- Main and renderer intentionally require different Monaco IDs for the same extension.
- A shared import pulls Electron or renderer runtime code into the other process.
- Preserving current default-body behavior conflicts with a matrix test; stop and document the
  product decision rather than silently changing it.

## Maintenance notes

New extension support should start in the shared matrix, then add preview-kind handling only if the
format is richer than generic code/text.
