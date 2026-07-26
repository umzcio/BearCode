# Hermes Attachment Preview Design

## Context

BearCode's native Hermes platform now delivers files in both directions:

- BearCode uploads locally selected files to Hermes with their verified bytes
  and original names.
- Hermes downloads files into BearCode's private attachment store with their
  verified bytes and original names.

The remaining gap is presentation. Clicking a downloaded document currently
hands a temporary, extensionless copy to the operating system. This leaves
BearCode, loses the original filename during the handoff, and can race the
temporary-file cleanup. A downloaded attachment should instead use BearCode's
existing in-app preview experience while remaining an attachment rather than
becoming a versioned plan or walkthrough artifact.

## Goals

- Open every Hermes attachment pill in BearCode's Auxiliary Pane.
- Reuse BearCode's existing renderers for Markdown, text, code, images, PDF,
  CSV/XLSX, DOCX, and HTML.
- Run HTML attachments interactively in BearCode's existing sandbox.
- Let the user save the original file through a native **Save As…** dialog.
- Preserve the original filename without exposing a server or local storage
  path to the renderer.
- Keep transcript reloads and existing downloaded attachments working without
  a database or wire-protocol migration.

## Non-goals

- Attachments do not become BearCode `artifact` events. Plans and walkthroughs
  retain their version, status, comments, and review semantics.
- The preview is read-only; editing and uploading a modified copy are not part
  of this change.
- Relative multi-file website assets are not reconstructed. An HTML attachment
  is previewed as the standalone file Hermes delivered.
- The Hermes home-channel notice and `/sethome` behavior are a separate task.
- The native Hermes file-transfer protocol does not change.

## User Experience

Every returned attachment pill is interactive, including image pills. Clicking
one selects it in the right-side Auxiliary Pane.

The pane header shows:

- the original filename;
- the file-type badge;
- the verified size;
- a **Download…** action; and
- the standard pane close control.

The body renders the attachment with the existing preview vocabulary:

- Markdown uses BearCode's sanitized Markdown renderer.
- Text and source code use the existing text/Monaco views.
- Images and PDFs render in place.
- CSV/XLSX render as tables.
- DOCX renders through the existing isolated Office extraction worker.
- HTML runs through BearCode's existing `bearcode-preview://` protocol and
  sandboxed iframe with scripts enabled, an opaque origin, no network, and no
  BearCode, parent-page, or local-file access.
- Unsupported, missing, oversized, or corrupt files produce an explicit pane
  message rather than falling back to an operating-system application.

Attachment selection is ephemeral UI state. Closing the pane or changing
conversations clears it. The persisted `assistant_attachment` transcript event
remains the source of the pill and its metadata, so a reloaded conversation can
open the same stored bytes again.

## Architecture

### Auxiliary Pane selection

Extend the existing auxiliary selection union with an attachment target
containing only the conversation ID and attachment ID. The transcript pill
dispatches this selection instead of calling the operating-system open IPC.
The pane resolves display metadata from the selected conversation's persisted
`assistant_attachment` event.

The existing artifact and diff modes remain unchanged. Attachment mode is a
peer mode with its own header and preview body.

### Shared preview rendering

Separate the existing `FilePreview` loading concern from its rendering
concern:

- the existing diff preview continues loading `PreviewPayload` through
  `diffs.previewFile`;
- the attachment preview loads `PreviewPayload` through the new attachment
  preview IPC; and
- both pass the result to one shared preview-content renderer.

This preserves the current renderers and sandbox instead of creating a second
format stack.

### Main-process attachment resolution

Add a main-process resolver that accepts only a conversation ID and attachment
ID. It:

1. validates both opaque IDs with the existing strict grammars;
2. finds the matching persisted `assistant_attachment` event in that
   conversation;
3. resolves the canonical
   `userData/attachments/<conversationId>/<attachmentId>` path;
4. rejects symbolic links and non-regular files;
5. opens the file with `O_NOFOLLOW`;
6. reads at most the existing 10 MiB limit;
7. verifies the exact opened descriptor against the persisted size and SHA-256;
8. confirms the canonical path still names the opened inode; and
9. returns only verified bytes and allowlisted metadata to the preview or
   download operation.

The renderer never supplies or receives a filesystem path. The persisted
filename is used only for display, format classification, and the Save As
default after basename/control-character sanitization. It never participates
in attachment-store path construction.

### Preview IPC

Add `attachments.preview(conversationId, attachmentId)`, returning the existing
`PreviewPayload` union.

Refactor the current diff-preview format classification/render preparation
into a reusable main-process function that accepts a trusted display name,
declared MIME, and verified bytes. Diff previews and attachment previews keep
their current public IPCs while sharing this internal implementation.

Extend the existing `bearcode-preview://` protocol with an attachment route
containing only encoded conversation and attachment IDs plus the sanitized
display name. The protocol handler resolves and verifies the stored attachment
again on every request and serves it with the existing preview-specific CSP,
which allows in-document scripts while denying network access and parent-page
access. It never accepts a renderer-provided filesystem path.

HTML attachments return the existing `html-url` payload pointing at this
attachment route. Requests for relative companion assets return 404 because a
native Hermes attachment represents one delivered file; the route never
expands access to the attachment store or another directory.

### Download IPC

Add `attachments.save(conversationId, attachmentId)`.

The main process resolves and verifies the attachment through the same
descriptor-based path as preview, then opens Electron's native Save As dialog
with the sanitized original filename. Cancel returns without side effects.

After confirmation, BearCode writes the verified bytes to a private temporary
file in the selected destination directory, syncs and closes it, and atomically
renames it over the confirmed destination. This avoids following a substituted
destination symlink and prevents a partially written final file. Any temporary
file is removed on failure. The attachment stored under BearCode `userData`
remains unchanged.

## Error Handling

- Preview IPC failures become a stable in-pane error state.
- A missing transcript event or stored file reports that the attachment is no
  longer available.
- Digest, size, inode, symbolic-link, and file-type failures report that the
  attachment could not be verified.
- Unsupported formats retain the existing `PreviewPayload` unsupported state.
- Save-dialog cancellation is not an error and produces no toast.
- Save failures produce a user-visible error and leave no partial destination
  file.
- Conversation changes ignore stale preview promises so content from the
  previous conversation cannot appear in the new pane.

## Testing

Implementation follows test-driven development.

Main-process tests use real temporary files and cover:

- verified preview payloads for every supported format lane;
- standalone interactive HTML payloads;
- attachment preview-protocol routing, CSP, and rejection of relative asset
  requests;
- missing transcript metadata and missing stored bytes;
- invalid IDs and traversal attempts;
- symbolic-link source and path-substitution attacks;
- size and SHA-256 mismatches;
- the 10 MiB boundary;
- Save As success, cancellation, original-name sanitization, atomic
  replacement, cleanup on failure, and destination-link substitution; and
- no filesystem path crossing the IPC boundary.

Renderer and store tests cover:

- document and image pills selecting attachment mode;
- attachment selection clearing on close and conversation switch;
- pane header metadata and Download… routing;
- loading, supported, unsupported, missing, and stale-response states;
- use of the shared preview renderer;
- sandbox attributes for interactive HTML; and
- persisted transcript attachments reopening after reload.

Regression verification includes the focused attachment suites, the complete
BearCode Vitest suite, the complete Hermes Python suite, typecheck comparison
against the known baseline, and a production Electron build.

## Acceptance Criteria

1. Clicking `CAIRN_project_plan.md` opens rendered Markdown in BearCode's
   Auxiliary Pane and does not launch TextEdit.
2. Clicking a delivered HTML file opens an interactive sandboxed preview.
3. Download… opens Save As with the original filename and saves byte-identical
   content to the chosen destination.
4. Images, PDFs, Office documents, spreadsheets, source code, and plain text
   use their existing BearCode preview lanes.
5. Reloading a conversation preserves preview and download behavior.
6. No attachment-store path or unverified filename crosses into the renderer
   or controls local path resolution.
7. The existing bidirectional Hermes file-transfer behavior remains unchanged.
