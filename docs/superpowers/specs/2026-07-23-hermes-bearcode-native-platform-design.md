# Hermes Native Platform Integration for BearCode

**Date:** 2026-07-23
**Status:** Design sections approved; written spec pending final review

## Summary

BearCode will integrate with Hermes as a first-class Hermes platform, in the same architectural category as Slack or Telegram. The integration will be delivered as an out-of-tree Hermes user plugin rather than as a patch to the Hermes API server or installed Hermes source.

Version 1 targets interactive use while BearCode is open:

- streamed assistant responses;
- persistent Hermes session continuity;
- tool progress and results;
- approval and clarification prompts;
- BearCode-to-Hermes image and document uploads;
- Hermes-to-BearCode image and document delivery; and
- cancellation and structured errors.

Offline delivery, scheduled/background messages, and notification queues are not part of version 1.

## Context and Problem

BearCode currently talks to the Hermes OpenAI-compatible API on `umzspark:8642`. Text chat works, but the API surface is not equivalent to a Hermes platform adapter:

- requests contain text only;
- chat-completions streaming consumes only `choices[0].delta.content`;
- inbound API messages reject general file inputs;
- outbound files are not represented by a durable attachment protocol;
- tool-progress events are ignored; and
- platform-native approval and clarification flows are not connected to BearCode.

Hermes can send and receive files in Slack because the Slack integration is a platform adapter. It downloads inbound Slack files into Hermes media caches and implements outbound methods such as `send_document()` and `send_image_file()`. The shared Hermes gateway then routes media, approvals, and other interaction events through that adapter.

The missing capability is therefore not a Slack-specific file protocol that BearCode can reuse. It is a BearCode platform adapter plus a BearCode-native transport.

## Goals

1. Make BearCode a first-class interactive Hermes platform.
2. Match the useful interactive behavior of Hermes in Slack without requiring Slack.
3. Keep credentials and file bytes in the BearCode main process.
4. Preserve Hermes upgradeability by making zero edits under `/usr/local/lib/hermes-agent`.
5. Provide an explicit, versioned wire contract that can evolve independently of BearCode UI code.
6. Preserve the existing text-only API integration as an explicit legacy mode.
7. Fail visibly and safely; native mode must never silently downgrade.

## Non-Goals

- Receiving Hermes messages while BearCode is closed.
- Scheduled or proactive Hermes delivery.
- A durable server-side message queue.
- Migrating existing BearCode Hermes conversations into the native protocol.
- Reproducing Slack-specific UI or Slack APIs.
- Exposing arbitrary server filesystem paths to BearCode.
- Patching Hermes core or maintaining a permanent Hermes fork.
- Executing uploaded files.
- Adding model, effort, web-search, mention, slash-command, or browser controls to the Hermes composer in version 1.

## Architecture

### Components

The integration consists of:

1. **BearCode platform plugin**
   - Source-controlled at `integrations/hermes-bearcode/`.
   - Deployed to `~/.hermes/plugins/platforms/bearcode/` on `umzspark`.
   - Contains `plugin.yaml`, `adapter.py`, protocol implementation, and tests.
   - Extends Hermes `BasePlatformAdapter`.
   - Registers the `bearcode` platform through the supported plugin context.
   - Uses Hermes' existing gateway caches, media validation, message routing, and session machinery.

2. **BearCode native client**
   - Implemented in the Electron main process, initially at `src/main/hermes/nativeClient.ts`.
   - Owns authentication, WebSocket lifecycle, upload/download streams, hashing, retries, and protocol validation.
   - Emits safe, typed IPC events to the renderer.
   - Never exposes the platform key or raw server paths to the renderer.

3. **Existing BearCode renderer**
   - Reuses the current message list, tool display, approval UI, composer attachment UI, and attachment preview UI.
   - Adds mappings from native protocol events to existing application state and persistence.

4. **Existing legacy API client**
   - Remains available as an explicitly selected `Legacy API` connection mode.
   - Continues to use `:8642`.
   - Does not receive native attachment or interaction guarantees.

### Upgrade Boundary

Hermes supports user platform plugins under `~/.hermes/plugins/platforms/<name>/`. The BearCode adapter will use only that extension point. Deployment must not modify:

- `/usr/local/lib/hermes-agent`;
- installed Hermes adapters;
- Hermes' API server; or
- the Hermes Git checkout.

The repository copy is authoritative. The deployed plugin is a generated deployment artifact and can be replaced or rolled back independently of Hermes.

### Network Topology

Version 1 uses one authenticated WebSocket per active turn:

```text
BearCode renderer
       |
       | typed Electron IPC
       v
BearCode main process
       |
       | authenticated WebSocket over Tailscale
       v
BearCode Hermes plugin on umzspark
       |
       | BasePlatformAdapter / MessageEvent
       v
Hermes gateway, agent loop, tools, and media caches
```

The native listener defaults to a dedicated Tailscale-reachable port, for example `umzspark:8643`, rather than overloading the legacy OpenAI-compatible service on `:8642`. The exact host and port are configuration, not protocol constants.

Using a separate listener:

- avoids changes to the Hermes API server;
- gives the plugin ownership of WebSocket and binary framing;
- keeps native and legacy health/failure domains distinct; and
- makes rollback a configuration change.

## Protocol

### General Rules

- Protocol name: `bearcode-hermes`.
- Initial protocol version: `1`.
- Control frames are UTF-8 JSON text frames.
- File bodies are sent in bounded binary chunks associated with an attachment ID.
- Every turn has a client-generated UUID `turnId`.
- Every attachment has a client-generated or server-generated UUID `attachmentId`.
- Every server event after `turn.accepted` has a monotonically increasing `sequence` within that turn.
- Every post-handshake frame identifies protocol version 1.
- Unknown optional fields are ignored.
- Unknown required event types or an unsupported protocol version terminate the turn with a protocol error.
- Server filesystem paths never cross the wire.

Except for the handshake, server control events use this envelope:

```json
{
  "type": "assistant.delta",
  "version": 1,
  "turnId": "uuid",
  "sequence": 7,
  "payload": {
    "text": "Partial response"
  }
}
```

The event-specific value is always under `payload`. Events unrelated to an accepted turn, such as connection errors and heartbeats, omit `turnId` and use a connection-level sequence.

### Connection and Handshake

The client opens an authenticated WebSocket and sends:

```json
{
  "type": "hello",
  "protocol": "bearcode-hermes",
  "versions": [1],
  "client": {
    "name": "BearCode",
    "version": "1.0.0"
  },
  "conversationId": "local-conversation-uuid"
}
```

The server replies:

```json
{
  "type": "hello.accepted",
  "protocol": "bearcode-hermes",
  "version": 1,
  "connectionId": "uuid",
  "capabilities": {
    "streaming": true,
    "toolProgress": true,
    "approvals": true,
    "clarifications": true,
    "attachments": {
      "upload": true,
      "download": true,
      "maxFiles": 5,
      "maxBytesPerFile": 10485760
    }
  }
}
```

The server rejects authentication or incompatible versions before accepting uploads or starting a turn.

### Authentication

The WebSocket upgrade uses:

```http
Authorization: Bearer <BEARCODE_PLATFORM_KEY>
```

The key is a dedicated random secret, separate from the legacy API key. It is stored:

- in Hermes plugin configuration on `umzspark`; and
- in BearCode's existing encrypted credential vault.

The plugin compares tokens in constant time, rate-limits failed authentication, and never logs credentials or authorization headers.

### Inbound Attachments

BearCode uploads all attachments before `turn.start`.

For each attachment, it first sends metadata:

```json
{
  "type": "attachment.upload.begin",
  "turnId": "uuid",
  "attachment": {
    "id": "uuid",
    "name": "report.pdf",
    "declaredMime": "application/pdf",
    "sizeBytes": 412345,
    "sha256": "lowercase-hex"
  }
}
```

The plugin responds with `attachment.upload.accepted` or `attachment.upload.rejected`. On acceptance, BearCode sends binary chunks with a maximum payload of 256 KiB.

Every binary WebSocket frame has this 32-byte header followed by its payload:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `BCH1` |
| 4 | 1 | Protocol version, `0x01` |
| 5 | 1 | Direction: `0x01` upload, `0x02` download |
| 6 | 1 | Flags; bit 0 means final chunk |
| 7 | 1 | Reserved, must be zero |
| 8 | 16 | Attachment UUID as RFC 4122 network-order bytes |
| 24 | 4 | Zero-based chunk index, unsigned big-endian |
| 28 | 4 | Payload byte length, unsigned big-endian |

The remaining frame bytes are the payload and must exactly equal the header length. Chunks for an attachment are contiguous and strictly ordered. Empty files use one final frame with a zero-byte payload. The receiver rejects bad magic, unknown flags, gaps, duplicates, oversize payloads, length mismatches, or chunks for an unaccepted attachment.

The plugin:

1. streams the body to a restricted temporary file;
2. enforces declared and actual byte limits while streaming;
3. verifies SHA-256;
4. sniffs file type rather than trusting the declared MIME type;
5. sanitizes the display filename;
6. moves the verified file into the appropriate Hermes media cache; and
7. emits `attachment.upload.completed`.

Failed or disconnected uploads are deleted.

Version 1 matches BearCode's existing attachment limits:

- at most 5 files per message;
- at most 10 MiB per file; and
- the image, text/code, PDF, DOCX, and XLSX types already accepted by BearCode.

After all attachments complete, BearCode starts the turn:

```json
{
  "type": "turn.start",
  "turnId": "uuid",
  "conversationId": "local-conversation-uuid",
  "text": "Summarize the attached report.",
  "attachmentIds": ["uuid"]
}
```

The plugin converts this into the same Hermes `MessageEvent` and cached-media representation used by native platform adapters.

### Outbound Events

The plugin sends structured events rather than embedding control information in text:

- `turn.accepted`
- `assistant.started`
- `assistant.delta`
- `assistant.completed`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `approval.requested`
- `clarification.requested`
- `attachment.download.begin`
- binary attachment chunks
- `attachment.download.completed`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`
- `heartbeat`

Assistant text and tool events preserve their current BearCode semantics. The renderer does not parse human-readable assistant text to discover tools, approvals, or files.

`assistant.delta` carries only the next text fragment. `tool.*`, `approval.requested`, and `clarification.requested` carry stable request/tool IDs plus display-safe structured data. `turn.completed` includes the final Hermes session ID and terminal sequence. `turn.failed` uses the common error object defined below.

### Outbound Attachments

When Hermes routes validated media through `send_document()`, `send_image_file()`, or the equivalent adapter method, the plugin:

1. receives a Hermes-validated cached path;
2. confirms that the path belongs to an allowed Hermes media/cache root;
3. opens the file without exposing its path;
4. determines size, SHA-256, sanitized name, MIME type, and media kind;
5. sends `attachment.download.begin`;
6. streams bounded binary chunks; and
7. sends `attachment.download.completed`.

The begin event contains:

```json
{
  "type": "attachment.download.begin",
  "version": 1,
  "turnId": "uuid",
  "sequence": 12,
  "payload": {
    "attachment": {
      "id": "uuid",
      "name": "analysis.pdf",
      "mime": "application/pdf",
      "kind": "document",
      "sizeBytes": 412345,
      "sha256": "lowercase-hex"
    }
  }
}
```

BearCode writes the download to a restricted temporary file, verifies length and SHA-256, then atomically moves it to:

```text
userData/attachments/<conversationId>/<attachmentId>
```

Partial or invalid downloads are deleted. The renderer receives only attachment metadata and a BearCode-owned attachment ID.

### Interactive Responses

Approval and clarification responses are client events:

```json
{
  "type": "approval.resolve",
  "turnId": "uuid",
  "requestId": "uuid",
  "decision": "approve"
}
```

```json
{
  "type": "clarification.resolve",
  "turnId": "uuid",
  "requestId": "uuid",
  "response": "Use the quarterly totals."
}
```

The plugin routes them to the waiting Hermes interaction using the same adapter-level mechanisms as other platforms.

### Cancellation and Heartbeats

BearCode sends `turn.cancel` when the user cancels. The plugin interrupts the active Hermes turn and replies with `turn.cancelled`.

Client and server exchange heartbeats while a turn is active. A disconnected connection cancels its active turn after a short grace period. Version 1 does not queue the result for later delivery.

## Conversation and Concurrency Model

- A BearCode conversation maps to one Hermes session.
- The authenticated platform key identifies one trusted BearCode installation; its generated installation ID is the stable Hermes sender identity.
- New native conversations start fresh.
- Existing legacy conversations do not migrate and may be deleted by the user.
- At most one turn may be active per conversation.
- Different conversations may run concurrently.
- `turnId` is idempotent within a conversation.
- Repeating an accepted `turnId` returns its known state and never executes the turn twice.
- A connection may retry only before `turn.accepted`.
- Once tool execution may have begun, BearCode must not automatically replay the turn.

The session mapping must survive BearCode and Hermes restarts using stable conversation/session identifiers rather than an in-memory-only mapping.

## BearCode UI and Persistence

### Composer

For native Hermes conversations:

- re-enable the existing Media attachment control;
- keep voice input as local transcription into text;
- keep model, mode, effort, web, mentions, slash commands, and browser controls hidden in version 1.

For legacy API conversations, the current text-only restrictions remain visible and explicit.

### Messages

Native events map to existing BearCode UI concepts:

- assistant deltas update the streaming assistant message;
- tool lifecycle events update tool-progress rows/cards;
- approval and clarification events open the existing interaction UI;
- received files appear as assistant attachments with previews or download actions;
- failed turns preserve any partial assistant text and append an error card.

The conversation database stores attachment metadata, not file contents or remote paths:

```ts
type HermesAttachment = {
  id: string
  name: string
  mime: string
  kind: 'image' | 'document' | 'text' | 'other'
  sizeBytes: number
  sha256: string
}
```

A new assistant-attachment event is added to persistence so downloaded files reopen correctly after restarting BearCode.

### Connection Mode

Hermes connections expose an explicit mode:

- `Native Platform` — full version 1 protocol and capabilities;
- `Legacy API` — existing text-only OpenAI-compatible connection.

Native mode fails with an actionable error if the plugin is missing, unreachable, unauthorized, or incompatible. It never silently falls back to legacy mode.

## Security

1. Bind the native listener to the Tailscale interface by default.
2. Use `ws://` only inside the encrypted tailnet for version 1; allow `wss://` as a future configuration.
3. Use a dedicated high-entropy platform key.
4. Keep authentication and file handling in the Electron main process.
5. Rate-limit authentication failures.
6. Use constant-time token comparison.
7. Never log tokens, authorization headers, file bodies, or sensitive attachment text.
8. Enforce count and size limits before and during transfer.
9. Verify hashes and sniff MIME types.
10. Sanitize filenames and ignore client-provided paths.
11. Use restricted permissions for temporary and cached files.
12. Delete incomplete transfers.
13. Do not execute or automatically open uploads.
14. Validate every outbound path against allowed Hermes cache roots.
15. Send opaque IDs instead of server paths.

## Error Model

Protocol errors have a stable machine code, a safe user-facing message, a retryability flag, and optional structured details:

```json
{
  "code": "file.hash_mismatch",
  "message": "The received file failed integrity verification.",
  "retryable": false,
  "details": {
    "attachmentId": "uuid"
  }
}
```

Error families include:

- `auth.*`
- `protocol.*`
- `plugin.*`
- `network.*`
- `file.*`
- `hermes.*`
- `approval.*`
- `persistence.*`

Examples:

- `auth.invalid_key`
- `protocol.unsupported_version`
- `file.too_large`
- `file.hash_mismatch`
- `file.unsupported_type`
- `hermes.turn_failed`
- `network.disconnected`
- `persistence.attachment_write_failed`

Behavior:

- authentication and handshake errors end the connection;
- a failed upload prevents `turn.start`;
- a failed outbound download fails that attachment and visibly marks the turn;
- partial assistant text remains visible after a turn failure;
- automatic retry is limited to connection establishment before `turn.accepted`;
- no turn is automatically replayed after tool execution can have started.

## Testing Strategy

### Shared Protocol Fixtures

A language-neutral fixture set defines:

- handshake negotiation;
- every control event;
- binary chunk headers and reassembly;
- attachment hashes;
- invalid and forward-compatible messages; and
- canonical error payloads.

Both Python and TypeScript test suites consume the fixtures.

### Plugin Tests

Test:

- user-plugin discovery and registration;
- authentication and version negotiation;
- `MessageEvent` construction;
- inbound cache placement;
- outbound `MEDIA:`/adapter routing;
- document and image delivery;
- assistant, tool, approval, and clarification events;
- size, MIME, and hash enforcement;
- temporary-file cleanup;
- duplicate `turnId` behavior;
- cancellation and disconnect behavior;
- one-turn-per-conversation enforcement; and
- concurrent isolation between conversations.

### BearCode Tests

Test:

- WebSocket state transitions;
- authentication and handshake failures;
- upload and download chunking;
- size and hash verification;
- native event-to-UI mapping;
- assistant attachment persistence and reopening;
- approval and clarification replies;
- cancellation;
- explicit native/legacy mode selection;
- partial-result error behavior; and
- prevention of post-execution automatic retry.

### Integration Harness

Add a local integration harness using:

- the real Python platform plugin;
- a deterministic fake Hermes agent/gateway boundary; and
- the real TypeScript native client.

The harness covers the protocol without requiring `umzspark` for every test.

### Acceptance Smoke Test on `umzspark`

Before release, verify:

1. Create a new native conversation.
2. Stream a normal text response.
3. Observe tool start, progress, and completion.
4. Complete an approval prompt.
5. Complete a clarification prompt.
6. Upload an image.
7. Upload a PDF and a text/code file.
8. Receive a generated image.
9. Receive a generated document.
10. Cancel an active turn.
11. Restart BearCode and reopen the conversation and attachments.
12. Disable the plugin and confirm native mode reports a clear error.
13. Select legacy mode and confirm existing text chat still works.

## Deployment and Rollback

The repository will contain a deployment script that:

1. checks the installed Hermes version and required plugin API surface;
2. runs plugin and protocol tests;
3. stages a versioned plugin directory;
4. validates `plugin.yaml` and import/registration;
5. copies it to `~/.hermes/plugins/platforms/bearcode/`;
6. enables `bearcode` in `plugins.enabled`;
7. restarts the Hermes gateway only after validation; and
8. runs a handshake health check.

The deployment retains the previous deployed plugin version until the new version passes its health check. Rollback restores that version and restarts the gateway.

After every Hermes upgrade, a compatibility command runs:

- plugin discovery/import;
- adapter registration;
- protocol fixture tests;
- a no-tool text turn;
- an inbound attachment turn; and
- an outbound attachment turn.

A failed compatibility check blocks plugin deployment but does not modify or roll back Hermes itself.

## Implementation Boundaries

Likely BearCode areas:

- `integrations/hermes-bearcode/` — plugin, protocol fixtures, tests, deployment tooling;
- `src/main/hermes/nativeClient.ts` — native transport;
- main-process credential and attachment storage integration;
- IPC contracts for native events and interaction replies;
- renderer Hermes event mapping;
- composer capability gating;
- conversation/attachment persistence; and
- integration tests.

The implementation plan must verify exact filenames and existing abstractions before assigning changes. This design does not authorize edits to installed Hermes core.

## Decision Record

### Chosen: out-of-tree Hermes platform plugin

This provides the same class of integration Hermes uses for Slack while preserving Hermes upgradeability.

### Rejected: extend only the OpenAI-compatible API

Adding files to `/v1/chat/completions` would still require a custom output contract, interaction lifecycle, and streaming semantics. Patching the installed API server would create the upgrade burden this design is intended to avoid.

### Rejected: reuse Slack as an internal relay

This would add an unnecessary third-party dependency, couple BearCode identity and files to Slack, and preserve Slack-specific limitations instead of creating a native integration.

### Deferred: always-on delivery

Offline and proactive delivery require durable queues, acknowledgements across reconnects, notification policy, and retention rules. They are intentionally deferred until the interactive protocol is proven.

## Success Criteria

The design is successful when BearCode can be treated by Hermes as a native interactive platform:

- text, tools, approvals, clarifications, and files work bidirectionally;
- native conversations and attachments survive application restarts;
- failures are explicit and do not duplicate tool execution;
- the legacy `:8642` path remains available by explicit selection; and
- Hermes can be upgraded or reinstalled without reapplying a BearCode core patch.
