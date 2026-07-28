# Plan 016: Add copy and Markdown export for artifacts

> **Executor instructions**: Implement copy in the renderer and export through an opaque-ID native
> Save As path. Do not send arbitrary destinations or artifact bodies from renderer to main. Update
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactViewer.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/main/ipc.ts src/preload/index.ts src/shared/types.ts src/main/hermes/attachmentSave.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/005-preserve-artifact-comment-draft.md`, `plans/007-harden-browser-control-ipc.md`
- **Category**: direction
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

Diff files can be copied and attachments can be downloaded, but plan/walkthrough artifacts—the
pane’s durable deliverables—have no equivalent. Users should be able to copy the exact source
Markdown or export it through a safe native dialog without selecting text manually or exposing a
filesystem write primitive to the renderer.

## Current state

- `ArtifactViewer.tsx:196-239` renders title/version/status/actions but no copy/export controls.
- Diff copy at `ArtifactsPane.tsx:582-588` uses `window.bearcode.clipboard.write(...).then(toast)`.
- Attachment Save As at `ipc.ts:433-448` verifies an opaque ID, sanitizes the default leaf,
  opens `dialog.showSaveDialog`, and writes via the atomic/no-follow `saveVerifiedBytes` path.
- Artifact event bodies are Markdown (`shared/types.ts:620-631`) and the durable row is available
  with `db.getArtifact(id)` (`main/db/index.ts:1547-1550`).
- `sanitizeAttachmentName` removes path traversal, Windows separators/device names, control chars,
  and unsafe leaf characters; reuse or generalize it rather than writing weaker filename logic.

## Product contract

- “Copy Markdown” copies `selected.body` exactly and toasts only after success.
- “Export…” invokes `artifacts.saveMarkdown(artifactId)` with only the opaque ID.
- Main re-reads the durable artifact, proposes a sanitized `<title>.md` leaf, and writes UTF-8
  Markdown only after the user confirms.
- Cancel is silent; success toasts “Artifact exported”; failure retains controls and toasts
  “Could not export artifact”.
- Export is disabled while pending; duplicate dialogs are impossible.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Main IPC | `npx vitest run src/main/ipc.artifactExport.test.ts` | all pass |
| Preload | `npx vitest run src/preload/index.test.ts` | all pass |
| Viewer | `npx vitest run src/renderer/src/components/ArtifactViewer.test.tsx` | all pass |
| Types/build | `npm run typecheck && npm run build` | exit 0 |

## Scope

**In scope**:

- `src/shared/types.ts`
- `src/preload/index.ts` and tests
- `src/main/ipc.ts`
- `src/main/ipc.artifactExport.test.ts` (create)
- A small main export helper/test if needed
- `src/renderer/src/components/ArtifactViewer.tsx`, CSS, and tests

**Out of scope**:

- PDF/DOCX/XLSX conversion
- Accepting renderer-provided body/title/destination
- Auto-writing into the workspace
- Exporting comments or review metadata
- Adding a general arbitrary-file write API

## Git workflow

- Branch: `advisor/016-add-artifact-copy-export`
- Commit: `feat: copy and export artifacts`

## Steps

### Step 1: Add main boundary tests

Capture the new handler and mock `db.getArtifact`, dialog, and atomic writer. Test:

- unknown/malformed artifact ID rejects before dialog;
- existing artifact produces a plain sanitized `.md` default leaf;
- cancel writes nothing and returns `cancelled`;
- confirmed destination receives exactly `Buffer.from(artifact.body, 'utf8')`;
- write errors reject;
- malicious titles cannot control parent directory or Windows device names;
- the handler ignores any extra renderer body/path argument.

Use a dedicated `artifactExportName` helper if needed and table-test it.

**Verify**: tests fail before implementation.

### Step 2: Add opaque typed API and safe main implementation

Add `artifacts.saveMarkdown(artifactId): Promise<'saved'|'cancelled'>` to `BearcodeApi` and preload.
In main, validate ID shape, load the durable row, sanitize a title-based leaf with exactly one `.md`
extension, show Save As, and use the existing safe atomic byte writer (or extract a generic safe-byte
writer without weakening attachment tests).

Do not accept conversation ID, body, title, or output path over IPC.

**Verify**: main and preload tests pass.

### Step 3: Add viewer controls and transactional feedback

Add labeled controls in the artifact title/action row using existing control styles. Copy awaits the
clipboard promise and toasts success only afterward; catch failure. Export has local pending state,
awaits the result, keeps cancellation silent, prevents duplicate calls, and handles rejection.
Reset pending safely if the selected artifact changes mid-dialog; a completion for artifact A must
not toast or mutate artifact B.

**Verify**: viewer tests cover exact copy body, cancel, success, failure, duplicate, and selection
change.

### Step 4: Run checks

Run all commands in the table and scoped lint.

## Test plan

Main tests own trust boundary/filename/bytes. Preload tests own exact channel and opaque argument.
Viewer tests own accessible controls and feedback timing. Include Markdown containing Unicode and
NUL-like text in body to prove bytes are content, not a path.

## Done criteria

- [ ] Copy returns exact source Markdown.
- [ ] Export crosses IPC with only artifact ID.
- [ ] Main re-reads durable body and sanitizes default leaf.
- [ ] Cancel writes/toasts nothing; failure never toasts success.
- [ ] Duplicate export dialogs are blocked.
- [ ] Tests/typecheck/build/lint pass; index updated.

## STOP conditions

- Artifact IDs have no runtime-validatable shape beyond non-empty string; use DB existence as the
  authority and do not invent a regex that rejects real IDs.
- Reusing the atomic writer would expose attachment-specific incorrect behavior/error copy; extract
  carefully or stop.
- Product intent requires rendered export rather than Markdown; that is a separate format project.

## Maintenance notes

Keep export formats explicit methods; do not evolve this into `save(path, bytes)`. The opaque-ID
pattern is the security property.
