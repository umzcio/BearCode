# Hermes Attachment Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Open verified Hermes attachments inside BearCode's Auxiliary Pane, render them through BearCode's existing preview lanes, and let the user save byte-identical files through a secure native Save As dialog.

**Architecture:** The renderer selects attachments by opaque conversation and attachment IDs only. The main process resolves the matching persisted `assistant_attachment` event, verifies the canonical stored file through an `O_NOFOLLOW` descriptor, and returns an existing `PreviewPayload` or saves the verified bytes. Diff and attachment previews share one format renderer. Standalone HTML is re-verified on every `bearcode-preview://attachment/...` request and runs in the existing network-denied sandbox.

**Tech Stack:** Electron 43, TypeScript 7, React 19, Zustand 5, Vitest 4, Node filesystem/crypto APIs, existing BearCode preview protocol and Office extraction worker.

## Global Constraints

- Follow test-driven development: add the named failing test, run it and observe the expected failure, implement the smallest production change, then rerun it green.
- Do not change the Hermes WebSocket wire protocol, Python plugin, attachment database schema, or `assistant_attachment` event shape.
- The renderer must never send or receive an attachment-store filesystem path.
- Persisted attachment metadata is authoritative. A renderer-supplied ID alone never authorizes a read.
- Enforce the existing `MAX_ATTACHMENT_BYTES` 10 MiB limit before and during each read.
- Keep the existing diff-preview `bearcode-preview://preview/...` route and sibling-asset behavior unchanged.
- An attachment HTML route serves exactly one verified file. Relative companion requests return 404.
- Keep iframe sandboxing at `sandbox="allow-scripts"`: scripts may run, but no `allow-same-origin`, parent access, `window.bearcode`, local-file access, or network access.
- Attachments remain transcript attachments. Do not create or mutate artifact records, versions, statuses, comments, or review state.
- Preserve the exact original stored bytes and use only a sanitized basename as the display/default download name.
- Do not add runtime dependencies.

---

### Task 1: Read only persisted, verified attachment bytes

**Files:**

- Create: `src/main/hermes/attachmentAccess.ts`
- Create: `src/main/hermes/attachmentAccess.test.ts`
- Reference: `src/main/hermes/nativeFiles.ts`
- Reference: `src/main/attachments/ingest.ts`
- Reference: `src/main/db/index.ts`
- Reference: `src/shared/types.ts`

- [x] **Step 1: Add real-filesystem tests for metadata lookup and name sanitization**

Create `attachmentAccess.test.ts` with helpers that create:

```ts
const conversationId = 'conv_123'
const attachment: HermesAttachment = {
  id: 'att_123',
  name: 'CAIRN_project_plan.md',
  mime: 'text/markdown',
  kind: 'document',
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex')
}
const events: Event[] = [{
  id: 'evt_123',
  type: 'assistant_attachment',
  attachment
}]
```

Assert all of the following:

- the matching event returns the exact metadata and bytes;
- an unknown attachment ID reports `Attachment is no longer available`;
- a matching attachment event from another conversation is not accepted because callers pass only that conversation's event list;
- `sanitizeAttachmentName('../../CAIRN.md')` returns `CAIRN.md`;
- backslashes and control characters are removed;
- an empty or dot-only result falls back to `attachment`.

- [x] **Step 2: Run the new test and confirm RED**

Run:

```bash
npx vitest run src/main/hermes/attachmentAccess.test.ts
```

Expected: Vitest fails because `./attachmentAccess` does not exist.

- [x] **Step 3: Implement the metadata resolver and descriptor-based reader**

Create these public contracts:

```ts
export interface VerifiedStoredAttachment {
  attachment: Readonly<HermesAttachment>
  bytes: Buffer
}

export function sanitizeAttachmentName(name: string): string

export async function readVerifiedStoredAttachment(
  userDataDir: string,
  conversationId: string,
  attachmentId: string,
  events: readonly Event[]
): Promise<VerifiedStoredAttachment>
```

Implementation requirements:

1. Call `assertValidConversationId(conversationId)` and
   `assertValidAttachmentId(attachmentId)` before filesystem access.
2. Find an event where `event.type === 'assistant_attachment'` and
   `event.attachment.id === attachmentId`.
3. Resolve the leaf only with
   `resolveStoredAttachmentPath(userDataDir, conversationId, attachmentId)`.
4. `lstat` the attachment root, conversation directory, and leaf; reject
   symlinks and non-directories/non-regular files.
5. Open the leaf with
   `constants.O_RDONLY | constants.O_NOFOLLOW`.
6. Read from the exact descriptor in chunks, rejecting observed bytes above
   `MAX_ATTACHMENT_BYTES`.
7. Compare descriptor size and observed size to persisted `sizeBytes`.
8. Compare SHA-256 with a fixed-size buffer through `timingSafeEqual`.
9. `fstat` again and `lstat` the canonical leaf again; require unchanged
   `dev`, `ino`, and size so a pathname substitution cannot pass.
10. Always close the handle and return a copied/frozen metadata object plus
    the verified `Buffer`.

Use stable error categories:

```ts
throw new Error('Attachment is no longer available')
throw new Error('Attachment could not be verified')
throw new Error('Attachment is too large')
```

- [x] **Step 4: Add adversarial filesystem tests**

Extend `attachmentAccess.test.ts` to assert rejection of:

- invalid conversation and attachment IDs, including `../escape`;
- missing attachment root, conversation directory, and stored leaf;
- symlinked attachment root, conversation directory, and leaf;
- a directory at the leaf;
- persisted size mismatch;
- persisted SHA-256 mismatch;
- a file of exactly 10 MiB succeeds;
- a file of 10 MiB plus one byte fails;
- replacing the canonical leaf after the descriptor opens fails the final
  inode/path check.

For the pathname-replacement case, inject a narrow test seam:

```ts
export interface AttachmentReadHooks {
  afterOpen?: () => Promise<void> | void
}
```

Make it the optional fifth argument to `readVerifiedStoredAttachment`; do not
expose it through IPC.

- [x] **Step 5: Run the focused suite green**

Run:

```bash
npx vitest run src/main/hermes/attachmentAccess.test.ts
```

Expected: all new tests pass.

- [x] **Step 6: Commit Task 1**

```bash
git add src/main/hermes/attachmentAccess.ts src/main/hermes/attachmentAccess.test.ts
git commit -m "feat: verify stored Hermes attachments"
```

---

### Task 2: Share preview rendering and add a standalone attachment protocol route

**Files:**

- Create: `src/main/preview/render.ts`
- Create: `src/main/preview/render.test.ts`
- Modify: `src/main/preview/protocol.ts`
- Modify: `src/main/preview/protocol.test.ts`
- Reference: `src/main/preview/classify.ts`
- Reference: `src/main/attachments/office.ts`
- Reference: `src/main/attachments/extract.ts`
- Reference: `src/main/db/index.ts`

- [x] **Step 1: Specify a byte-oriented shared preview renderer**

Add table-driven tests to `render.test.ts` for:

- PNG/JPEG/SVG -> `image` data URL;
- PDF -> `pdf` data URL;
- Markdown -> `markdown`;
- CSV/XLSX -> `table`;
- DOCX -> sandboxable `html`;
- JSON -> pretty `code` with `language: 'json'`;
- known source extensions -> `code` with the classified language;
- HTML -> `html-url` using the caller-provided URL;
- plain text -> `text`;
- Office extraction failure -> `unsupported`.

Mock only `runOfficeHtml` and `runOfficeRows`; use real buffers for every
other lane.

- [x] **Step 2: Run the render test and confirm RED**

Run:

```bash
npx vitest run src/main/preview/render.test.ts
```

Expected: the test fails because `./render` does not exist.

- [x] **Step 3: Extract the current diff format logic into `renderPreviewPayload`**

Implement:

```ts
export interface PreviewSource {
  name: string
  mime: string
  bytes: Buffer
  htmlUrl: string
}

export async function renderPreviewPayload(
  source: PreviewSource
): Promise<PreviewPayload>
```

Classify by trusted `source.name`, not a store path. Preserve the current
`diffs.preview` behavior exactly:

```ts
const classification = previewClassify(source.name)
if (classification.kind === 'html') {
  return { kind: 'html-url', url: source.htmlUrl }
}
```

Keep Office parsing behind `runOfficeHtml`/`runOfficeRows`, keep JSON
pretty-print fallback, and return existing unsupported notes for extraction
failures.

- [x] **Step 4: Specify opaque attachment preview URLs and protocol responses**

Extend `protocol.test.ts` with assertions that:

```ts
attachmentPreviewUrlFor('conv_123', 'att_123', 'My page.html')
```

equals:

```text
bearcode-preview://attachment/conv_123/att_123/My%20page.html
```

Add handler-level tests using an injected verified-reader callback:

- `GET` of the exact attachment URL returns the verified bytes;
- response headers include `text/html`, `PREVIEW_CSP`, `nosniff`, and
  `no-store`;
- the callback receives only decoded conversation and attachment IDs;
- malformed encoding, invalid IDs, unknown host, and non-GET return 4xx;
- `/conv_123/att_123/My%20page.html/style.css` returns 404 and never calls
  the reader;
- the existing `preview` host still resolves the diff file and sibling assets.

- [x] **Step 5: Run protocol tests and confirm RED**

Run:

```bash
npx vitest run src/main/preview/protocol.test.ts
```

Expected: the new tests fail because no attachment host or URL builder exists.

- [x] **Step 6: Extend the protocol without weakening the diff route**

Add:

```ts
const ATTACHMENT_HOST = 'attachment'

export function attachmentPreviewUrlFor(
  conversationId: string,
  attachmentId: string,
  displayName: string
): string

export async function handlePreviewRequest(
  request: Request,
  dependencies?: {
    filePathFor?: (fileId: string) => string | null
    readAttachment?: (
      conversationId: string,
      attachmentId: string
    ) => Promise<VerifiedStoredAttachment>
  }
): Promise<Response>
```

Production `registerPreviewProtocol` supplies a reader that calls:

```ts
readVerifiedStoredAttachment(
  app.getPath('userData'),
  conversationId,
  attachmentId,
  db.getEvents(conversationId)
)
```

Route by `url.host`:

- `preview`: retain the existing jailed diff-file and sibling-asset behavior;
- `attachment`: require exactly three decoded path segments, treat the third
  only as a display URL segment, verify the requested attachment again, and
  serve its bytes with `mimeFor(attachment.name)`;
- anything else: 404.

The attachment route must not use the display-name segment for lookup or path
construction. `PREVIEW_CSP` must still contain no `http:`, `https:`, or `ws:`
sources.

- [x] **Step 7: Run both focused suites green**

Run:

```bash
npx vitest run src/main/preview/render.test.ts src/main/preview/protocol.test.ts
```

Expected: both suites pass, including existing diff-protocol tests.

- [x] **Step 8: Commit Task 2**

```bash
git add src/main/preview/render.ts src/main/preview/render.test.ts \
  src/main/preview/protocol.ts src/main/preview/protocol.test.ts
git commit -m "feat: preview verified Hermes attachments"
```

---

### Task 3: Expose preview by opaque IDs and reuse the renderer for diffs

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.test.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/ipc.previewFile.test.ts`
- Create: `src/main/ipc.attachmentPreview.test.ts`

- [x] **Step 1: Add failing public-API and IPC tests**

In `src/preload/index.test.ts`, assert:

```ts
expect(window.bearcode.attachments.preview('conv_123', 'att_123'))
```

invokes:

```ts
ipcRenderer.invoke('bearcode:attachments:preview', 'conv_123', 'att_123')
```

In `ipc.attachmentPreview.test.ts`, mock the verified reader and shared
renderer, register the IPC handlers, invoke the captured handler, and assert:

- `db.getEvents('conv_123')` supplies the persisted metadata;
- the verified attachment's name, MIME, and bytes reach
  `renderPreviewPayload`;
- HTML receives
  `attachmentPreviewUrlFor('conv_123', 'att_123', sanitizedName)`;
- no filesystem path appears in the arguments or returned payload;
- unavailable/corrupt reads resolve to
  `{ kind: 'unsupported', note: 'Attachment could not be loaded' }`.

Extend `ipc.previewFile.test.ts` to assert that the existing diff IPC delegates
to `renderPreviewPayload` and passes `previewUrlFor(fileId, path)` for HTML.

- [x] **Step 2: Run the IPC/preload tests and confirm RED**

Run:

```bash
npx vitest run src/preload/index.test.ts \
  src/main/ipc.previewFile.test.ts \
  src/main/ipc.attachmentPreview.test.ts
```

Expected: failures report the missing `attachments.preview` API and IPC
handler.

- [x] **Step 3: Add the typed preload method**

Add the preview method immediately after `read` in
`BearcodeApi.attachments` in `src/shared/types.ts`:

```ts
preview(conversationId: string, id: string): Promise<PreviewPayload>
```

Keep `open` temporarily for compatibility; Task 4 removes its UI caller.

Expose in `src/preload/index.ts`:

```ts
preview: (conversationId, id) =>
  ipcRenderer.invoke('bearcode:attachments:preview', conversationId, id)
```

- [x] **Step 4: Register attachment preview IPC and refactor diff preview**

In `src/main/ipc.ts`, add:

```ts
ipcMain.handle(
  'bearcode:attachments:preview',
  async (_event, conversationId: string, attachmentId: string): Promise<PreviewPayload> => {
    try {
      const verified = await readVerifiedStoredAttachment(
        app.getPath('userData'),
        conversationId,
        attachmentId,
        db.getEvents(conversationId)
      )
      return renderPreviewPayload({
        name: verified.attachment.name,
        mime: verified.attachment.mime,
        bytes: verified.bytes,
        htmlUrl: attachmentPreviewUrlFor(
          conversationId,
          attachmentId,
          sanitizeAttachmentName(verified.attachment.name)
        )
      })
    } catch {
      return { kind: 'unsupported', note: 'Attachment could not be loaded' }
    }
  }
)
```

Replace the format switch inside `bearcode:diffs:preview` with:

```ts
return renderPreviewPayload({
  name: path,
  mime: mimeFor(path),
  bytes,
  htmlUrl: previewUrlFor(fileId, path)
})
```

Preserve the current not-found, too-large, and read-failure notes around the
existing stat/read guard.

- [x] **Step 5: Run the focused tests green**

Run:

```bash
npx vitest run src/preload/index.test.ts \
  src/main/ipc.previewFile.test.ts \
  src/main/ipc.attachmentPreview.test.ts
```

Expected: all focused tests pass and existing diff-preview assertions remain
green.

- [x] **Step 6: Run a no-path boundary assertion**

Add a test that recursively scans the attachment preview result and its preload
arguments:

```ts
expect(JSON.stringify(result)).not.toContain(userDataDir)
expect(invoke).not.toHaveBeenCalledWith(
  expect.anything(),
  expect.stringContaining(userDataDir)
)
```

Rerun `ipc.attachmentPreview.test.ts` and confirm green.

- [x] **Step 7: Commit Task 3**

```bash
git add src/shared/types.ts src/preload/index.ts src/preload/index.test.ts \
  src/main/ipc.ts src/main/ipc.previewFile.test.ts \
  src/main/ipc.attachmentPreview.test.ts
git commit -m "feat: expose Hermes attachment previews"
```

---

### Task 4: Open every returned attachment in the Auxiliary Pane

**Files:**

- Create: `src/renderer/src/components/FilePreview/PreviewContent.tsx`
- Create: `src/renderer/src/components/FilePreview/PreviewContent.test.tsx`
- Modify: `src/renderer/src/components/FilePreview/FilePreview.tsx`
- Modify: `src/renderer/src/components/FilePreview/FilePreview.test.tsx`
- Create: `src/renderer/src/components/AttachmentPreview/AttachmentPreview.tsx`
- Create: `src/renderer/src/components/AttachmentPreview/AttachmentPreview.css`
- Create: `src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx`
- Modify: `src/renderer/src/components/events/HermesAttachment.tsx`
- Modify: `src/renderer/src/components/events/HermesAttachment.test.tsx`
- Modify: `src/renderer/src/components/AuxiliaryPane.tsx`
- Modify: `src/renderer/src/components/ReviewPanel.css`
- Create: `src/renderer/src/components/AuxiliaryPane.test.tsx`
- Modify: `src/renderer/src/state/store.ts`
- Modify: `src/renderer/src/state/store.test.ts`

- [x] **Step 1: Lock down the shared renderer before extraction**

Move the existing payload-lane expectations into
`PreviewContent.test.tsx`. Explicitly assert:

- Markdown calls the sanitized `Markdown` component;
- code lazy-loads Monaco with the correct language;
- HTML string and `html-url` both use
  `sandbox="allow-scripts"` without `allow-same-origin`;
- image and PDF use the payload data URL;
- table rows render;
- unsupported and text messages render.

Add a `FilePreview.test.tsx` assertion that stale diff promises do not replace
the current file's loading state.

- [x] **Step 2: Run the renderer tests and confirm RED**

Run:

```bash
npx vitest run \
  src/renderer/src/components/FilePreview/PreviewContent.test.tsx \
  src/renderer/src/components/FilePreview/FilePreview.test.tsx
```

Expected: the new shared component test fails because `PreviewContent` does
not exist.

- [x] **Step 3: Extract the pure preview component**

Create:

```tsx
export function PreviewContent({
  payload
}: {
  payload: PreviewPayload
}): React.JSX.Element
```

Move every current payload branch, `HtmlPreview`, and the lazy Monaco import
from `FilePreview.tsx` into this component without changing CSS classes or
sandbox attributes. Leave `FilePreview` responsible only for loading:

```tsx
if (!payload) return <div className="file-preview loading">Loading preview…</div>
return <PreviewContent payload={payload} />
```

- [x] **Step 4: Add failing store and pill-selection tests**

In `store.test.ts`, assert:

- `openAttachmentPane('conv_123', 'att_123')` sets exactly
  `{ kind: 'attachment', conversationId: 'conv_123', attachmentId: 'att_123' }`;
- `closeReview()` clears it;
- switching to another conversation clears it.

In `HermesAttachment.test.tsx`, test both document and image pills:

- each is a keyboard-accessible button;
- clicking calls `openAttachmentPane` with opaque IDs;
- clicking never calls `window.bearcode.attachments.open`;
- image thumbnail loading still calls `attachments.read`.

Run:

```bash
npx vitest run src/renderer/src/state/store.test.ts \
  src/renderer/src/components/events/HermesAttachment.test.tsx
```

Expected: failures report the missing selection kind/action and current OS-open
behavior.

- [x] **Step 5: Implement selection and route all attachment pills**

Extend:

```ts
export type AuxSelection =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'diff'; diffId: string }
  | { kind: 'browser'; conversationId: string }
  | { kind: 'file'; path: string; line?: number }
  | {
      kind: 'attachment'
      conversationId: string
      attachmentId: string
    }
```

Add:

```ts
openAttachmentPane(conversationId: string, attachmentId: string): void
```

to the store interface and implementation. Preserve the current
`openConvo`/`closeReview` clearing behavior.

In `HermesAttachment.tsx`, use a button for both image and non-image pills and
dispatch:

```tsx
onClick={() => openAttachmentPane(convoId, attachment.id)}
```

Keep lazy image-byte loading for the transcript thumbnail only.

- [x] **Step 6: Add failing attachment body and pane tests**

In `AttachmentPreview.test.tsx`, assert:

- it calls `attachments.preview(conversationId, attachmentId)`;
- loading is shown until the matching request resolves;
- a rejected IPC displays `Could not load preview`;
- changing either ID ignores a stale prior promise;
- the loaded payload is passed to `PreviewContent`.

In `AuxiliaryPane.test.tsx`, seed a persisted `assistant_attachment` event and
assert:

- attachment mode has filename, file badge, and formatted verified size;
- no artifact rail, version controls, status, feedback, or comments appear;
- the standard close control calls `closeReview`;
- missing event metadata shows `Attachment is no longer available`;
- after store rehydration/reload, the persisted event can reopen the pane.

- [x] **Step 7: Implement the attachment pane**

Create:

```tsx
export function AttachmentPreview({
  conversationId,
  attachmentId
}: {
  conversationId: string
  attachmentId: string
}): React.JSX.Element
```

Use the same live/stale guard as `FilePreview`, then render
`<PreviewContent payload={payload} />`.

In `AuxiliaryPane.tsx`, handle `sel.kind === 'attachment'` before artifact/diff
resolution. Resolve metadata only from the selected conversation's persisted
`assistant_attachment` event. Render a peer attachment header with:

```tsx
<span>{attachment.name}</span>
<span>{attachmentBadge(attachment.name, attachment.mime).label}</span>
<span>{formatBytes(attachment.sizeBytes)}</span>
```

and the existing pane close button. Do not construct an `Artifact`, rail, or
version list. Add a local `formatBytes(sizeBytes: number): string` helper beside
the existing `baseName`/`languageFor` helpers so the verified size has a stable
human-readable representation.

- [x] **Step 8: Run all Task 4 suites green**

Run:

```bash
npx vitest run \
  src/renderer/src/components/FilePreview/PreviewContent.test.tsx \
  src/renderer/src/components/FilePreview/FilePreview.test.tsx \
  src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx \
  src/renderer/src/components/events/HermesAttachment.test.tsx \
  src/renderer/src/components/AuxiliaryPane.test.tsx \
  src/renderer/src/state/store.test.ts
```

Expected: all suites pass and no test observes an OS-open call.

- [x] **Step 9: Commit Task 4**

```bash
git add src/renderer/src/components/FilePreview \
  src/renderer/src/components/AttachmentPreview \
  src/renderer/src/components/events/HermesAttachment.tsx \
  src/renderer/src/components/events/HermesAttachment.test.tsx \
  src/renderer/src/components/AuxiliaryPane.tsx \
  src/renderer/src/components/ReviewPanel.css \
  src/renderer/src/components/AuxiliaryPane.test.tsx \
  src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts
git commit -m "feat: open Hermes attachments in BearCode"
```

---

### Task 5: Save verified bytes through native Save As

**Files:**

- Create: `src/main/hermes/attachmentSave.ts`
- Create: `src/main/hermes/attachmentSave.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.test.ts`
- Modify: `src/main/ipc.ts`
- Create: `src/main/ipc.attachmentSave.test.ts`
- Modify: `src/renderer/src/components/AuxiliaryPane.tsx`
- Modify: `src/renderer/src/components/AuxiliaryPane.test.tsx`

- [x] **Step 1: Specify atomic destination writes**

In `attachmentSave.test.ts`, use real temporary directories to assert:

- a new destination contains byte-identical content and mode `0600`;
- an existing regular destination is atomically replaced;
- a destination symlink is rejected without altering its target;
- a temporary-name collision retries with a new random name;
- injected write/fsync/rename failure removes the private temporary file;
- no partial final file appears on failure.

Expose the narrow contract:

```ts
export async function saveVerifiedBytes(
  destination: string,
  bytes: Buffer,
  dependencies?: AttachmentSaveDependencies
): Promise<void>
```

The optional dependencies contain only random-name and filesystem operation
seams needed by tests.

- [x] **Step 2: Run the save test and confirm RED**

Run:

```bash
npx vitest run src/main/hermes/attachmentSave.test.ts
```

Expected: the test fails because `./attachmentSave` does not exist.

- [x] **Step 3: Implement private-temp, sync, and atomic rename**

Implement this sequence:

1. Resolve the absolute destination and parent directory.
2. `lstat` an existing destination and reject symbolic links/non-regular files.
3. Create a random sibling such as
   `.${basename(destination)}.${randomUUID()}.bearcode-tmp` with
   `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, mode `0600`.
4. Write the complete immutable verified buffer with a short-write loop.
5. `fsync` and close the temp descriptor.
6. Re-check that an existing destination was not replaced by a symlink.
7. Rename the sibling over the confirmed destination.
8. On every failure, close and unlink the sibling.

Never stream from the attachment-store pathname after the Save As dialog;
write only the already verified bytes.

- [x] **Step 4: Add failing Save As IPC and preload tests**

In `preload/index.test.ts`, assert `attachments.save` invokes:

```ts
ipcRenderer.invoke('bearcode:attachments:save', 'conv_123', 'att_123')
```

In `ipc.attachmentSave.test.ts`, assert:

- the same verified reader used by preview is called with
  `db.getEvents(conversationId)`;
- `dialog.showSaveDialog` receives the sanitized original name as
  `defaultPath`;
- cancellation returns `'cancelled'`, does not write, and creates no temp;
- confirmation passes the exact verified bytes to `saveVerifiedBytes` and
  returns `'saved'`;
- verification or save failure rejects so the renderer can report it;
- malicious stored names cannot choose a parent directory.

- [x] **Step 5: Run the API/IPC tests and confirm RED**

Run:

```bash
npx vitest run src/preload/index.test.ts src/main/ipc.attachmentSave.test.ts
```

Expected: failures report the missing `attachments.save` API and IPC handler.

- [x] **Step 6: Add the typed Save As API and main handler**

Add to `BearcodeApi.attachments`:

```ts
save(
  conversationId: string,
  id: string
): Promise<'saved' | 'cancelled'>
```

Expose the matching preload call. Register:

```ts
ipcMain.handle(
  'bearcode:attachments:save',
  async (_event, conversationId: string, attachmentId: string) => {
    const verified = await readVerifiedStoredAttachment(
      app.getPath('userData'),
      conversationId,
      attachmentId,
      db.getEvents(conversationId)
    )
    const result = await dialog.showSaveDialog({
      defaultPath: sanitizeAttachmentName(verified.attachment.name)
    })
    if (result.canceled || !result.filePath) return 'cancelled' as const
    await saveVerifiedBytes(result.filePath, verified.bytes)
    return 'saved' as const
  }
)
```

- [x] **Step 7: Add Download header-action tests and implementation**

Extend `AuxiliaryPane.test.tsx` to assert:

- a `Download…` button calls `attachments.save` with the same opaque IDs;
- `'cancelled'` produces no success or error toast;
- `'saved'` produces the existing success notification;
- rejection produces the existing error notification;
- repeated clicks are disabled while one save is pending.

Place the button directly in the attachment-mode header in
`AuxiliaryPane.tsx`, matching the existing Auxiliary Pane action styles. Keep
the pending flag local to that attachment selection, call the store's existing
`showToast` action for success/failure, and clear the flag in `finally`. Do not
put download state into the transcript event and do not add an OS-open action.

- [x] **Step 8: Run all Task 5 suites green**

Run:

```bash
npx vitest run \
  src/main/hermes/attachmentSave.test.ts \
  src/main/ipc.attachmentSave.test.ts \
  src/preload/index.test.ts \
  src/renderer/src/components/AuxiliaryPane.test.tsx
```

Expected: save, cancellation, cleanup, and UI-routing tests all pass.

- [x] **Step 9: Commit Task 5**

```bash
git add src/main/hermes/attachmentSave.ts \
  src/main/hermes/attachmentSave.test.ts src/main/ipc.ts \
  src/main/ipc.attachmentSave.test.ts src/shared/types.ts \
  src/preload/index.ts src/preload/index.test.ts \
  src/renderer/src/components/AuxiliaryPane.tsx \
  src/renderer/src/components/AuxiliaryPane.test.tsx
git commit -m "feat: download Hermes attachments"
```

---

### Task 6: Regression, security review, and live acceptance

**Files:**

- Modify only if verification finds a defect: files changed in Tasks 1-5
- Update: `docs/superpowers/plans/2026-07-25-hermes-attachment-preview.md`

- [x] **Step 1: Run every focused attachment and preview suite**

```bash
npx vitest run \
  src/main/hermes/attachmentAccess.test.ts \
  src/main/hermes/attachmentSave.test.ts \
  src/main/preview/render.test.ts \
  src/main/preview/protocol.test.ts \
  src/main/ipc.previewFile.test.ts \
  src/main/ipc.attachmentPreview.test.ts \
  src/main/ipc.attachmentSave.test.ts \
  src/preload/index.test.ts \
  src/renderer/src/components/FilePreview/PreviewContent.test.tsx \
  src/renderer/src/components/FilePreview/FilePreview.test.tsx \
  src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx \
  src/renderer/src/components/events/HermesAttachment.test.tsx \
  src/renderer/src/components/AuxiliaryPane.test.tsx \
  src/renderer/src/state/store.test.ts
```

Expected: all focused suites pass.

- [x] **Step 2: Run the complete BearCode suite**

```bash
npm test
```

Expected: the complete Vitest suite passes with no regression from the prior
2637/2637 baseline.

- [x] **Step 3: Check TypeScript against the known baseline**

```bash
npm run typecheck:node
npm run typecheck:web
```

Expected: no diagnostic references a file changed by this plan. Record the
known pre-existing node diagnostics separately; do not label them as caused
by this change.

- [x] **Step 4: Build the production Electron bundles**

```bash
npx electron-vite build
```

Expected: main, preload, and renderer bundles complete successfully.

- [x] **Step 5: Prove the native Hermes plugin is untouched**

Run from the repository worktree:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
  integrations/hermes-bearcode/.venv/bin/python -m unittest discover \
  -s integrations/hermes-bearcode/tests -p 'test_*.py' -q
```

Expected: the same 183/183 Python tests pass.

- [x] **Step 6: Run hygiene and security checks**

```bash
git diff --check
rg -n "TODO|TBD|FIXME|PLACEHOLDER" \
  src/main/hermes/attachmentAccess.ts \
  src/main/hermes/attachmentSave.ts \
  src/main/preview/render.ts \
  src/main/preview/protocol.ts \
  src/renderer/src/components/AttachmentPreview
rg -n "allow-same-origin|https?:|\\bws:" src/main/preview/protocol.ts \
  src/renderer/src/components/FilePreview/PreviewContent.tsx
```

Expected:

- `git diff --check` is silent;
- no placeholder markers occur in new implementation;
- `allow-same-origin` does not occur;
- any URL-like matches are comments explaining denial, not CSP sources;
- attachment preview/save IPC accepts IDs only.

- [x] **Step 7: Perform an independent code review**

Use `superpowers:requesting-code-review` with the approved design and this
plan. Require explicit review of:

- renderer/main trust boundary;
- event-to-byte authorization;
- source and destination symlink/path-substitution resistance;
- 10 MiB enforcement and digest comparison;
- HTML sandbox/CSP and exact-file routing;
- stale React promise handling;
- diff-preview and bidirectional Hermes regressions.

Resolve every Critical or Important finding with a failing regression test
before changing production code, then rerun Steps 1-6.

- [x] **Step 8: Run live macOS acceptance**

Start the worktree dev app:

```bash
npm run dev
```

Using the existing native endpoint
`ws://100.65.206.87:8643/v1/bearcode`, verify:

1. Request `CAIRN_project_plan.md`; clicking the pill opens rendered Markdown
   in BearCode's Auxiliary Pane and does not launch TextEdit.
2. Click a returned image; it opens in the same pane.
3. Return the known `claude-ladder (4).html`; interactive behavior runs inside
   the pane, while a network request from that page fails.
4. Reload the conversation and reopen both files from persisted transcript
   events.
5. Choose **Download…**, save to a temporary user-selected destination, and
   compare:

   ```bash
   shasum -a 256 "/chosen/path/CAIRN_project_plan.md"
   ```

   against the persisted attachment SHA-256 shown by the server/test fixture.
6. Cancel a second Save As and confirm no file or notification is produced.

- [x] **Step 9: Record evidence and commit any verification-only adjustments**

Check every completed item in this plan. If verification required code fixes,
stage only the exact regression tests and production files changed by those
fixes, then commit them together:

```bash
git commit -m "fix: close Hermes attachment preview review findings"
```

If no adjustment was needed, do not create an empty commit.

---

## Completion Gate

Before claiming completion, use `superpowers:verification-before-completion`
and confirm:

- every checkbox above is complete;
- the approved design's seven acceptance criteria have direct automated or
  live evidence;
- no source path crossed IPC;
- Save As produced byte-identical output;
- HTML ran interactively without gaining network or BearCode access;
- the Hermes WebSocket protocol and Python plugin remained unchanged;
- the worktree is clean except for explicitly documented user-owned changes.
