# Hermes Native Platform Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BearCode a first-class interactive Hermes platform with streamed chat, session continuity, tool activity, approvals, clarifications, and bidirectional images/documents while keeping Hermes core untouched.

**Architecture:** Add an out-of-tree Python platform plugin under `integrations/hermes-bearcode/` and deploy it to the Hermes runtime user's plugin directory. A versioned authenticated WebSocket connects that adapter to a TypeScript client in BearCode's Electron main process; the renderer receives only existing BearCode events and opaque attachment IDs through typed IPC.

**Tech Stack:** Python 3.11, `aiohttp`, Hermes `BasePlatformAdapter`, TypeScript 7, Electron 43, Node `ws`, Zod 4, SQLite, React 19, Vitest 4, Python `unittest`, Bash, Tailscale.

## Global Constraints

- Make zero edits under `/usr/local/lib/hermes-agent`; use only the supported user-plugin path.
- Keep plugin source under `integrations/hermes-bearcode/`; deploy to `$HERMES_HOME/plugins/platforms/bearcode/` (`/root/.hermes/plugins/platforms/bearcode/` on the current `umzspark` service).
- Protocol name is `bearcode-hermes`; protocol version is exactly `1`.
- Native transport defaults to `ws://umzspark:8643`; host and port remain configuration.
- Keep `:8642` as the explicit `Legacy API` mode and never silently fall back from native mode.
- Native V1 works only while BearCode is open; no offline queue, scheduled delivery, or proactive background delivery.
- Allow at most 5 files per turn and 10 MiB per file; binary chunk payloads are at most 256 KiB.
- Support the image, text/code, PDF, DOCX, and XLSX types BearCode already accepts.
- Keep the platform key and all file bytes in the Electron main process; never expose credentials or server filesystem paths to the renderer.
- Validate size, SHA-256, MIME, filenames, IDs, and cache roots; delete every partial transfer.
- Permit one active turn per conversation and concurrent turns in different conversations.
- Retry connection establishment only before `turn.accepted`; never replay a turn after tool execution can have started.
- New native conversations start fresh; existing Hermes conversations default to `legacy` and are not migrated.
- Current Hermes compatibility baseline: v0.19.0, commit `93c97073d857230b7de095b7885e25a3be0306fa`.
- Every commit message's final line must be `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>`.

## File Map

### Hermes plugin

- `integrations/hermes-bearcode/plugin.yaml` — user-plugin manifest and required/optional environment variables.
- `integrations/hermes-bearcode/requirements-dev.txt` — local test dependency pinned to the installed Hermes `aiohttp` version.
- `integrations/hermes-bearcode/.gitignore` — ignores only the plugin-local `.venv/`.
- `integrations/hermes-bearcode/adapter.py` — `BasePlatformAdapter` subclass and `register(ctx)` entry point only.
- `integrations/hermes-bearcode/bearcode_transport/protocol.py` — JSON envelope validation and 32-byte binary frame codec.
- `integrations/hermes-bearcode/bearcode_transport/security.py` — bearer comparison, auth rate limiting, UUID/filename/MIME/path validation.
- `integrations/hermes-bearcode/bearcode_transport/transfers.py` — bounded inbound upload and outbound download state machines.
- `integrations/hermes-bearcode/bearcode_transport/ledger.py` — durable accepted/terminal `turnId` idempotency records.
- `integrations/hermes-bearcode/bearcode_transport/connection.py` — one WebSocket's handshake, uploads, turn control, interaction replies, and terminal lifecycle.
- `integrations/hermes-bearcode/bearcode_transport/server.py` — authenticated `aiohttp` WebSocket listener and active-conversation registry.
- `integrations/hermes-bearcode/tests/` — Python unit and adapter-contract tests using `unittest`.
- `integrations/hermes-bearcode/fixtures/protocol-v1/` — language-neutral JSON fixtures and binary fixture metadata consumed by Python and TypeScript.
- `integrations/hermes-bearcode/scripts/install-local.sh` — root-side validated installation/rollback under `$HERMES_HOME`.
- `integrations/hermes-bearcode/scripts/healthcheck.py` — authenticated WebSocket handshake probe.
- `integrations/hermes-bearcode/scripts/check-compatibility.py` — Hermes API-surface and plugin-registration gate.

### BearCode main/shared

- `src/main/hermes/protocol.ts` — TypeScript mirror of protocol V1 plus fixture tests.
- `src/main/hermes/nativeFiles.ts` — safe upload descriptors and atomic verified download writers.
- `src/main/hermes/nativeClient.ts` — WebSocket state machine and `HermesNativeTurn`.
- `src/main/hermes/nativeRunner.ts` — maps native events to BearCode events/persistence and owns active interactions.
- `src/main/orchestrator/hermes.ts` — explicit per-conversation native/legacy dispatch.
- `src/main/orchestrator/graph.ts` — pass `AttachmentRef[]` into the Hermes runner.
- `src/main/orchestrator/index.ts` — route native cancel before local graph approval cancellation.
- `src/main/settings.ts`, `src/main/keys.ts`, `src/main/db/index.ts` — native URL/mode, platform key/installation ID, and per-conversation Hermes mode.
- `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts` — typed mode, connection test, interaction, attachment-open, and conversation-create contracts.

### BearCode renderer

- `src/renderer/src/state/store.ts` — preserve `hermesMode`, select mode at creation, and resolve native interactions.
- `src/renderer/src/lib/transcript.ts` — bucket native tool, clarification, and assistant-attachment events.
- `src/renderer/src/components/events/HermesToolStep.tsx` — arbitrary Hermes tool lifecycle and approval card.
- `src/renderer/src/components/events/HermesClarifyCard.tsx` — choice/free-text clarification card.
- `src/renderer/src/components/events/HermesAttachment.tsx` — received image/document presentation.
- `src/renderer/src/components/events/WorkedGroup.tsx` — render Hermes tools alongside local tool activity.
- `src/renderer/src/components/ConversationView.tsx` — received attachments and pinned Hermes interactions.
- `src/renderer/src/components/Composer/Composer.tsx` — Media-only context control for native Hermes.
- `src/renderer/src/components/Settings/pages/HermesPage.tsx` — explicit Native Platform/Legacy API configuration.

---

### Task 1: Freeze Protocol V1 in Shared Fixtures and Codecs

**Files:**
- Create: `integrations/hermes-bearcode/fixtures/protocol-v1/hello.json`
- Create: `integrations/hermes-bearcode/fixtures/protocol-v1/events.json`
- Create: `integrations/hermes-bearcode/fixtures/protocol-v1/binary.json`
- Create: `integrations/hermes-bearcode/bearcode_transport/__init__.py`
- Create: `integrations/hermes-bearcode/bearcode_transport/protocol.py`
- Create: `integrations/hermes-bearcode/tests/test_protocol.py`
- Create: `src/main/hermes/protocol.ts`
- Create: `src/main/hermes/protocol.test.ts`

**Interfaces:**
- Produces Python `encode_event`, `decode_client_event`, `encode_binary_frame`, and `decode_binary_frame`.
- Produces TypeScript `parseServerEvent`, `encodeClientEvent`, `encodeBinaryFrame`, and `decodeBinaryFrame`.
- Produces `HermesClientEvent`, `HermesServerEvent`, `BinaryDirection`, and `BinaryChunk`.
- Consumed by every later transport, runner, and integration task.

- [ ] **Step 1: Add canonical handshake and event fixtures**

Create `hello.json` with one accepted handshake and one version rejection:

```json
{
  "client": {
    "type": "hello",
    "protocol": "bearcode-hermes",
    "versions": [1],
    "client": { "name": "BearCode", "version": "1.0.0" },
    "conversationId": "11111111-1111-4111-8111-111111111111",
    "installationId": "22222222-2222-4222-8222-222222222222"
  },
  "accepted": {
    "type": "hello.accepted",
    "protocol": "bearcode-hermes",
    "version": 1,
    "connectionId": "33333333-3333-4333-8333-333333333333",
    "capabilities": {
      "streaming": true,
      "toolProgress": true,
      "approvals": true,
      "clarifications": true,
      "attachments": {
        "upload": true,
        "download": true,
        "maxFiles": 5,
        "maxBytesPerFile": 10485760,
        "maxChunkBytes": 262144
      }
    }
  },
  "rejected": {
    "type": "hello.rejected",
    "protocol": "bearcode-hermes",
    "supportedVersions": [1],
    "error": {
      "code": "protocol.unsupported_version",
      "message": "No mutually supported protocol version.",
      "retryable": false
    }
  }
}
```

Create `events.json` as an object with `clientEvents` and `serverEvents` arrays. Include every V1 control type:

```json
{
  "clientEvents": [
    {
      "type": "attachment.upload.begin",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "attachment": {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "report.pdf",
        "declaredMime": "application/pdf",
        "kind": "pdf",
        "sizeBytes": 4,
        "sha256": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"
      }
    },
    {
      "type": "turn.start",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "conversationId": "11111111-1111-4111-8111-111111111111",
      "text": "Read this.",
      "attachmentIds": ["55555555-5555-4555-8555-555555555555"]
    },
    {
      "type": "approval.resolve",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "requestId": "66666666-6666-4666-8666-666666666666",
      "decision": "once"
    },
    {
      "type": "clarification.resolve",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "requestId": "77777777-7777-4777-8777-777777777777",
      "response": "Use quarterly totals."
    },
    {
      "type": "turn.cancel",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444"
    },
    {
      "type": "heartbeat",
      "version": 1,
      "nonce": "hb-1"
    }
  ],
  "serverEvents": [
    {
      "type": "attachment.upload.accepted",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "attachmentId": "55555555-5555-4555-8555-555555555555"
    },
    {
      "type": "attachment.upload.completed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "attachmentId": "55555555-5555-4555-8555-555555555555"
    },
    {
      "type": "attachment.upload.rejected",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "attachmentId": "55555555-5555-4555-8555-555555555555",
      "error": {
        "code": "file.unsupported_type",
        "message": "The file type is not supported.",
        "retryable": false
      }
    },
    {
      "type": "turn.accepted",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 1,
      "payload": {}
    },
    {
      "type": "turn.duplicate",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 1,
      "payload": { "status": "accepted" }
    },
    {
      "type": "assistant.started",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 2,
      "payload": { "messageId": "88888888-8888-4888-8888-888888888888" }
    },
    {
      "type": "assistant.delta",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 3,
      "payload": {
        "messageId": "88888888-8888-4888-8888-888888888888",
        "text": "Hello"
      }
    },
    {
      "type": "assistant.completed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 4,
      "payload": { "messageId": "88888888-8888-4888-8888-888888888888" }
    },
    {
      "type": "tool.started",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 5,
      "payload": {
        "toolCallId": "99999999-9999-4999-8999-999999999999",
        "name": "_status",
        "label": "Running a command"
      }
    },
    {
      "type": "tool.progress",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 6,
      "payload": {
        "toolCallId": "99999999-9999-4999-8999-999999999999",
        "label": "Running a command"
      }
    },
    {
      "type": "tool.completed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 7,
      "payload": {
        "toolCallId": "99999999-9999-4999-8999-999999999999",
        "status": "completed"
      }
    },
    {
      "type": "approval.requested",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 8,
      "payload": {
        "requestId": "66666666-6666-4666-8666-666666666666",
        "toolCallId": "99999999-9999-4999-8999-999999999999",
        "command": "git status",
        "description": "Inspect repository status",
        "allowSession": true,
        "allowPermanent": false,
        "smartDenied": false
      }
    },
    {
      "type": "clarification.requested",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 9,
      "payload": {
        "requestId": "77777777-7777-4777-8777-777777777777",
        "question": "Which totals?",
        "choices": ["Monthly", "Quarterly"]
      }
    },
    {
      "type": "attachment.download.begin",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 10,
      "payload": {
        "attachment": {
          "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "name": "analysis.pdf",
          "mime": "application/pdf",
          "kind": "document",
          "sizeBytes": 4,
          "sha256": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"
        }
      }
    },
    {
      "type": "attachment.download.completed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 11,
      "payload": { "attachmentId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
    },
    {
      "type": "turn.completed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 12,
      "payload": { "sessionId": "bearcode:2222:1111" }
    },
    {
      "type": "turn.failed",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 13,
      "payload": {
        "error": {
          "code": "hermes.turn_failed",
          "message": "Hermes could not complete the turn.",
          "retryable": false
        }
      }
    },
    {
      "type": "turn.cancelled",
      "version": 1,
      "turnId": "44444444-4444-4444-8444-444444444444",
      "sequence": 14,
      "payload": {}
    }
  ]
}
```

Create `binary.json` with the canonical frame fields and expected 32-byte header hex:

```json
{
  "direction": "upload",
  "attachmentId": "55555555-5555-4555-8555-555555555555",
  "chunkIndex": 0,
  "final": true,
  "payloadHex": "00010203",
  "headerHex": "4243483101010100555555555555455585555555555555550000000000000004"
}
```

- [ ] **Step 2: Write failing Python codec tests**

In `test_protocol.py`, load fixtures using `Path(__file__).parents[1] / "fixtures/protocol-v1"` and assert:

```python
class ProtocolTests(unittest.TestCase):
    def test_binary_fixture_round_trips(self):
        raw = bytes.fromhex(self.binary["headerHex"] + self.binary["payloadHex"])
        decoded = decode_binary_frame(raw)
        self.assertEqual(decoded.direction, BinaryDirection.UPLOAD)
        self.assertEqual(str(decoded.attachment_id), self.binary["attachmentId"])
        self.assertEqual(decoded.chunk_index, 0)
        self.assertTrue(decoded.final)
        self.assertEqual(decoded.payload, b"\x00\x01\x02\x03")
        self.assertEqual(encode_binary_frame(decoded), raw)

    def test_rejects_payload_larger_than_256_kib(self):
        chunk = BinaryChunk(
            BinaryDirection.UPLOAD,
            UUID("55555555-5555-4555-8555-555555555555"),
            0,
            True,
            b"x" * (262144 + 1),
        )
        with self.assertRaisesRegex(ProtocolViolation, "payload"):
            encode_binary_frame(chunk)
```

Also assert every client fixture decodes, every server fixture encodes, bad magic fails, reserved flags fail, payload-length mismatch fails, non-V1 control frames fail, and invalid UUIDs fail.

- [ ] **Step 3: Run Python tests to verify they fail**

Run:

```bash
python3 -m unittest integrations/hermes-bearcode/tests/test_protocol.py -v
```

Expected: import failure for `bearcode_transport.protocol`.

- [ ] **Step 4: Implement the Python protocol codec**

Use these constants and data model in `protocol.py`:

```python
PROTOCOL_NAME = "bearcode-hermes"
PROTOCOL_VERSION = 1
MAGIC = b"BCH1"
HEADER = struct.Struct(">4sBBBB16sII")
HEADER_BYTES = 32
MAX_CHUNK_BYTES = 256 * 1024
MAX_FILES = 5
MAX_FILE_BYTES = 10 * 1024 * 1024

class BinaryDirection(IntEnum):
    UPLOAD = 1
    DOWNLOAD = 2

@dataclass(frozen=True)
class BinaryChunk:
    direction: BinaryDirection
    attachment_id: UUID
    chunk_index: int
    final: bool
    payload: bytes

class ProtocolViolation(ValueError):
    pass
```

`decode_client_event` must allow only the six fixture client types, require version 1 after the handshake, validate UUID fields, reject unknown top-level keys needed for execution, and return a clean dictionary. `encode_event` must emit compact JSON with no filesystem paths. Upload accepted/completed/rejected frames are pre-turn control responses and therefore carry no turn sequence; `SequenceGuard` begins only at `turn.accepted`.

The `assistant.delta` payload accepts optional `replace: true`; when present, `text` is the authoritative complete message rather than an append-only fragment.

- [ ] **Step 5: Write failing TypeScript codec tests**

Load the same fixtures from `integrations/hermes-bearcode/fixtures/protocol-v1`. Pin:

```ts
it('matches the canonical binary fixture byte-for-byte', () => {
  const frame = encodeBinaryFrame({
    direction: 'upload',
    attachmentId: binary.attachmentId,
    chunkIndex: 0,
    final: true,
    payload: Buffer.from(binary.payloadHex, 'hex')
  })
  expect(frame.toString('hex')).toBe(binary.headerHex + binary.payloadHex)
  expect(decodeBinaryFrame(frame)).toMatchObject({
    direction: 'upload',
    attachmentId: binary.attachmentId,
    chunkIndex: 0,
    final: true
  })
})
```

Also test every server fixture, sequence validation inputs, malformed JSON, unsupported version, bad magic, flags, lengths, and oversize chunks.

- [ ] **Step 6: Run TypeScript tests to verify they fail**

Run:

```bash
npx vitest run src/main/hermes/protocol.test.ts
```

Expected: module-not-found failure for `./protocol`.

- [ ] **Step 7: Implement the TypeScript codec**

Use discriminated unions and Zod validation. Export:

```ts
export const HERMES_PROTOCOL = 'bearcode-hermes' as const
export const HERMES_PROTOCOL_VERSION = 1 as const
export const HERMES_MAX_FILES = 5
export const HERMES_MAX_FILE_BYTES = 10 * 1024 * 1024
export const HERMES_MAX_CHUNK_BYTES = 256 * 1024

export interface HermesWireError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, string | number | boolean>
}

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'
export type BinaryDirection = 'upload' | 'download'

export interface BinaryChunk {
  direction: BinaryDirection
  attachmentId: string
  chunkIndex: number
  final: boolean
  payload: Buffer
}
```

The server-event schema must enumerate every fixture type. `SequenceGuard.accept(event)` must reject duplicate, decreasing, or skipped server sequence numbers after `turn.accepted`.

- [ ] **Step 8: Run both codec suites**

Run:

```bash
python3 -m unittest integrations/hermes-bearcode/tests/test_protocol.py -v
npx vitest run src/main/hermes/protocol.test.ts
```

Expected: all protocol tests pass.

- [ ] **Step 9: Commit the protocol contract**

```bash
git add integrations/hermes-bearcode/fixtures integrations/hermes-bearcode/bearcode_transport integrations/hermes-bearcode/tests src/main/hermes/protocol.ts src/main/hermes/protocol.test.ts
git commit -m "feat: freeze Hermes native protocol v1" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 2: Build Secure Transfer and Authentication Primitives

**Files:**
- Create: `integrations/hermes-bearcode/bearcode_transport/security.py`
- Create: `integrations/hermes-bearcode/bearcode_transport/transfers.py`
- Create: `integrations/hermes-bearcode/tests/test_security.py`
- Create: `integrations/hermes-bearcode/tests/test_transfers.py`

**Interfaces:**
- Consumes protocol limits and `BinaryChunk` from Task 1.
- Produces `AuthRateLimiter`, `verify_bearer`, `sanitize_filename`, `validate_outbound_path`, `UploadTransfer`, and `iter_download_frames`.
- Task 3's server owns these objects but does not duplicate validation.

- [ ] **Step 1: Write failing security tests**

Cover:

```python
class SecurityTests(unittest.TestCase):
    def test_bearer_compare_requires_exact_secret(self):
        self.assertTrue(verify_bearer("Bearer alpha", "alpha"))
        self.assertFalse(verify_bearer("Bearer alph", "alpha"))
        self.assertFalse(verify_bearer("alpha", "alpha"))

    def test_rate_limiter_blocks_after_five_failures(self):
        limiter = AuthRateLimiter(max_failures=5, window_seconds=60)
        for _ in range(5):
            limiter.record_failure("100.64.0.2", now=10)
        self.assertFalse(limiter.allowed("100.64.0.2", now=11))
        self.assertTrue(limiter.allowed("100.64.0.2", now=71))

    def test_filename_is_basename_and_control_free(self):
        self.assertEqual(sanitize_filename("../../bad\\x00name.pdf"), "badname.pdf")
```

Create temporary allowed and outside directories and assert `validate_outbound_path` accepts only regular files whose resolved path stays below an allowed root, including symlink escapes.

- [ ] **Step 2: Write failing transfer tests**

Use `TemporaryDirectory` and test:

- declared sizes above 10 MiB reject before file creation;
- chunks must be contiguous and match attachment/direction;
- streamed bytes cannot exceed the declared size;
- final length and SHA-256 must match;
- failure and disconnect remove `.partial` files;
- completion returns verified bytes/path metadata;
- outbound iteration emits at most 256 KiB per chunk and exactly one final chunk;
- outbound files above 10 MiB reject before the first download frame;
- empty files emit one zero-byte final chunk.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python3 -m unittest integrations/hermes-bearcode/tests/test_security.py integrations/hermes-bearcode/tests/test_transfers.py -v
```

Expected: import failures for `security` and `transfers`.

- [ ] **Step 4: Implement authentication and validation**

`verify_bearer` must split the scheme, reject empty values, and call `hmac.compare_digest`. `AuthRateLimiter` stores only timestamps by remote address and prunes old entries on every check. Use this MIME allowlist:

```python
ALLOWED_MIMES = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
})
```

Allow `text/*` only after strict UTF-8 decode of a sample. Sniff PNG/JPEG/WEBP/GIF/PDF and OOXML magic; for OOXML distinguish DOCX/XLSX by ZIP member names. Never trust `declaredMime`.

- [ ] **Step 5: Implement bounded transfers**

`UploadTransfer` must expose `begin(cls, temp_root: Path, metadata: dict) -> UploadTransfer`, `append(self, chunk: BinaryChunk) -> None`, `complete(self) -> VerifiedUpload`, and `abort(self) -> None`.

Use `os.open` with mode `0o600`, `O_CREAT | O_EXCL | O_WRONLY`, incremental `hashlib.sha256`, and an atomic rename only after all verification succeeds.

- [ ] **Step 6: Run transfer/security tests**

Run:

```bash
python3 -m unittest integrations/hermes-bearcode/tests/test_security.py integrations/hermes-bearcode/tests/test_transfers.py -v
```

Expected: all tests pass with no leaked temporary files.

- [ ] **Step 7: Commit transfer primitives**

```bash
git add integrations/hermes-bearcode/bearcode_transport/security.py integrations/hermes-bearcode/bearcode_transport/transfers.py integrations/hermes-bearcode/tests/test_security.py integrations/hermes-bearcode/tests/test_transfers.py
git commit -m "feat: secure Hermes native file transfers" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 3: Implement the Authenticated WebSocket Server

**Files:**
- Create: `integrations/hermes-bearcode/requirements-dev.txt`
- Create: `integrations/hermes-bearcode/.gitignore`
- Create: `integrations/hermes-bearcode/bearcode_transport/ledger.py`
- Create: `integrations/hermes-bearcode/bearcode_transport/connection.py`
- Create: `integrations/hermes-bearcode/bearcode_transport/server.py`
- Create: `integrations/hermes-bearcode/tests/test_connection.py`
- Create: `integrations/hermes-bearcode/tests/test_server.py`

**Interfaces:**
- Consumes Task 1 codecs and Task 2 security/transfers.
- Produces `BearCodeConnection`, `ConnectionRegistry`, and `BearCodeServer`.
- Calls an injected delegate with `start_turn(connection, event, uploads)`, `cancel_turn(connection)`, `resolve_approval(connection, request_id, decision)`, and `resolve_clarification(connection, request_id, response)`.
- Task 4's adapter implements `TurnDelegate`.

- [ ] **Step 1: Write failing registry and handshake tests**

Before importing `aiohttp`, create:

```text
# integrations/hermes-bearcode/requirements-dev.txt
aiohttp==3.14.1
```

and:

```text
# integrations/hermes-bearcode/.gitignore
.venv/
```

Create the local environment:

```bash
python3 -m venv integrations/hermes-bearcode/.venv
integrations/hermes-bearcode/.venv/bin/pip install -r integrations/hermes-bearcode/requirements-dev.txt
```

Use `unittest.IsolatedAsyncioTestCase` and `aiohttp.test_utils`. Assert:

- missing/incorrect bearer gets HTTP 401 before WebSocket acceptance;
- sixth failed auth from one address gets HTTP 429;
- correct auth accepts WebSocket;
- first frame must be `hello`;
- incompatible versions receive `hello.rejected` then close;
- accepted capabilities match `hello.json`;
- server emits a heartbeat every 15 seconds and closes after 30 seconds without the matching client echo;
- a connection that does not send `turn.start` within 60 seconds after hello closes and releases its conversation claim;
- two active connections for the same conversation are rejected with `plugin.conversation_busy`;
- different conversation IDs can connect concurrently.

- [ ] **Step 2: Write failing turn-state tests**

Pin this state order:

```text
CONNECTED -> HELLO -> UPLOADING -> READY -> ACCEPTED -> TERMINAL -> CLOSED
```

Assert `turn.start` fails before uploads finish, more than 5 attachment IDs fail, unknown IDs fail, duplicate `turnId` returns the known state without calling the delegate twice, a duplicate remains blocked after constructing a new registry against the same SQLite ledger, reusing a `turnId` under another conversation is a protocol error, client disconnect after acceptance calls `cancel_turn`, and disconnect before acceptance only cleans uploads.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
integrations/hermes-bearcode/.venv/bin/python -m unittest integrations/hermes-bearcode/tests/test_connection.py integrations/hermes-bearcode/tests/test_server.py -v
```

Expected: import failures for `connection` and `server`.

- [ ] **Step 4: Implement the durable turn ledger and `ConnectionRegistry`**

`TurnLedger` uses Python's `sqlite3` under the plugin state directory. Its table is:

```sql
CREATE TABLE IF NOT EXISTS bearcode_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Create the ledger and its parent with modes `0o600` and `0o700`. Insert status `accepted` in a transaction before calling the Hermes delegate; update to `completed`, `failed`, or `cancelled` on terminal. Prune terminal rows older than 7 days and retain no more than 1024 rows. A duplicate emits `turn.duplicate` with the stored status and never executes again; response text and files are not retained.

`ConnectionRegistry` exposes `claim(self, conversation_id: UUID, connection: BearCodeConnection) -> bool`, `release(self, conversation_id: UUID, connection: BearCodeConnection) -> None`, and `get(self, conversation_id: str) -> Optional[BearCodeConnection]`.

Protect live-connection mutation with `asyncio.Lock`. Do not store response bodies or files in the ledger.

Define `TurnDelegate` as a `typing.Protocol` with these async methods:

- `start_turn(connection: BearCodeConnection, event: dict, uploads: list[VerifiedUpload]) -> None`
- `cancel_turn(connection: BearCodeConnection) -> None`
- `resolve_approval(connection: BearCodeConnection, request_id: str, decision: str) -> bool`
- `resolve_clarification(connection: BearCodeConnection, request_id: str, response: str) -> bool`

- [ ] **Step 5: Implement `BearCodeConnection`**

Required public methods are `send_event(self, event_type: str, payload: dict) -> None`, `send_attachment(self, path: Path, metadata: dict) -> None`, `mark_terminal(self, event_type: str, payload: dict) -> None`, and `send_event_threadsafe(self, event_type: str, payload: dict) -> None`.

The receive loop handles hello, upload begin/binary chunks, turn start, approval resolve, clarification resolve, cancel, and heartbeat. A heartbeat task sends a random nonce every 15 seconds and requires the matching client echo within 30 seconds. A separate 60-second pre-turn deadline prevents an idle handshake from holding a conversation claim indefinitely. It owns a monotonically increasing server sequence. On every exit it cancels both timers, aborts unfinished uploads, and releases the registry claim.

- [ ] **Step 6: Implement `BearCodeServer`**

Constructor:

```python
BearCodeServer(
    host: str,
    port: int,
    platform_key: str,
    delegate: TurnDelegate,
    temp_root: Path,
    state_root: Path,
)
```

`start()` creates an `aiohttp.web.Application`, registers only `GET /v1/bearcode`, and starts `AppRunner`/`TCPSite`. `stop()` closes active WebSockets, aborts turns, and cleans the runner. Never include authorization headers in access logs.

- [ ] **Step 7: Run server tests**

Run:

```bash
integrations/hermes-bearcode/.venv/bin/python -m unittest integrations/hermes-bearcode/tests/test_connection.py integrations/hermes-bearcode/tests/test_server.py -v
```

Expected: all tests pass.

- [ ] **Step 8: Commit the server**

```bash
git add integrations/hermes-bearcode/bearcode_transport/connection.py integrations/hermes-bearcode/bearcode_transport/server.py integrations/hermes-bearcode/tests/test_connection.py integrations/hermes-bearcode/tests/test_server.py
git commit -m "feat: add Hermes BearCode websocket server" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 4: Bind the Server to Hermes as a User Platform Plugin

**Files:**
- Create: `integrations/hermes-bearcode/plugin.yaml`
- Create: `integrations/hermes-bearcode/adapter.py`
- Create: `integrations/hermes-bearcode/tests/fakes/gateway/__init__.py`
- Create: `integrations/hermes-bearcode/tests/fakes/gateway/config.py`
- Create: `integrations/hermes-bearcode/tests/fakes/gateway/platforms/__init__.py`
- Create: `integrations/hermes-bearcode/tests/fakes/gateway/platforms/base.py`
- Create: `integrations/hermes-bearcode/tests/fakes/gateway/session.py`
- Create: `integrations/hermes-bearcode/tests/fakes/tools/__init__.py`
- Create: `integrations/hermes-bearcode/tests/fakes/tools/approval.py`
- Create: `integrations/hermes-bearcode/tests/fakes/tools/clarify_gateway.py`
- Create: `integrations/hermes-bearcode/tests/test_adapter.py`

**Interfaces:**
- Consumes `BearCodeServer` and implements its `TurnDelegate`.
- Produces `BearCodeAdapter(BasePlatformAdapter)` and `register(ctx)`.
- Hermes calls `connect`, `disconnect`, `send`, `edit_message`, `send_document`, `send_image_file`, `send_clarify`, `send_exec_approval`, `set_status_text`, `on_processing_start`, and `on_processing_complete`.

- [ ] **Step 1: Add the plugin manifest**

Use:

```yaml
name: bearcode-platform
label: BearCode
kind: platform
version: 1.0.0
description: Native interactive BearCode transport for Hermes Agent.
author: BearCode
requires_env:
  - name: BEARCODE_PLATFORM_KEY
    description: Dedicated bearer secret shared only with BearCode.
    prompt: BearCode platform key
    password: true
optional_env:
  - name: BEARCODE_LISTEN_HOST
    description: Tailscale address to bind; defaults to 127.0.0.1.
    prompt: BearCode listen host
    password: false
  - name: BEARCODE_LISTEN_PORT
    description: BearCode native WebSocket port; defaults to 8643.
    prompt: BearCode listen port
    password: false
  - name: BEARCODE_ALLOW_ALL_USERS
    description: Trust installation IDs after platform-key authentication.
    prompt: Trust authenticated BearCode installations
    password: false
```

- [ ] **Step 2: Write failing adapter-contract tests**

The fake base module must model only the installed signatures and record calls. Test:

- registration name is `bearcode`;
- factory returns `BearCodeAdapter`;
- `validate_config` requires a platform key and valid port;
- `connect()` starts the injected server;
- `disconnect()` stops it;
- inbound verified image/document bytes become Hermes cache paths in `MessageEvent.media_urls`;
- source uses `chat_id=conversationId`, `user_id=installationId`, `role_authorized=True`, and message ID `turnId`;
- `send` emits `assistant.started` and first delta;
- `edit_message` emits only the new suffix and `assistant.completed` on `finalize=True`;
- non-prefix edits emit a replacement delta containing the complete corrected text;
- `send_document`/`send_image_file` reject unsafe paths and stream accepted files;
- approval decisions call `resolve_gateway_approval(session_key, decision)`;
- clarification responses call `resolve_gateway_clarify(clarify_id, response)`;
- lifecycle completion emits exactly one terminal event.

- [ ] **Step 3: Run adapter tests to verify they fail**

Run:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
integrations/hermes-bearcode/.venv/bin/python -m unittest integrations/hermes-bearcode/tests/test_adapter.py -v
```

Expected: module-not-found failure for `adapter`.

- [ ] **Step 4: Implement adapter construction and registration**

Registration must be:

```python
def register(ctx):
    ctx.register_platform(
        name="bearcode",
        label="BearCode",
        adapter_factory=lambda cfg: BearCodeAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["BEARCODE_PLATFORM_KEY"],
        install_hint="aiohttp is included in the Hermes runtime",
        env_enablement_fn=_env_enablement,
        allowed_users_env="",
        allow_all_env="BEARCODE_ALLOW_ALL_USERS",
        max_message_length=200000,
        emoji="🐻",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "You are chatting in BearCode, a desktop coding client. "
            "Markdown, streamed text, approvals, clarifications, images, "
            "and downloadable documents are supported."
        ),
    )
```

`BearCodeAdapter.__init__` must use `Platform("bearcode")`, set `supports_status_text = True`, set `REQUIRES_EDIT_FINALIZE = True`, capture the running event loop during `connect`, and create the server under a cache-owned temporary root.

- [ ] **Step 5: Implement inbound Hermes event creation**

After uploads verify, call Hermes' unified cache helper:

```python
cached = cache_media_bytes(
    data,
    filename=name,
    mime_type=verified_mime,
    default_kind="image" if kind == "image" else "document",
)
if cached is None:
    raise ValueError("Hermes rejected the verified media bytes")
media_urls.append(cached.path)
media_types.append(cached.media_type)
```

Build:

```python
source = self.build_source(
    chat_id=conversation_id,
    chat_name="BearCode",
    chat_type="dm",
    user_id=installation_id,
    user_name="BearCode user",
    message_id=turn_id,
    role_authorized=True,
)
event = MessageEvent(
    text=text,
    message_type=MessageType.PHOTO if only_images else MessageType.DOCUMENT if media_urls else MessageType.TEXT,
    source=source,
    message_id=turn_id,
    media_urls=media_urls,
    media_types=media_types,
    metadata={"bearcode_turn_id": turn_id},
)
await self.handle_message(event)
```

Delete verified upload staging files after Hermes cache creation.

- [ ] **Step 6: Implement native outbound hooks**

`send` allocates a message UUID, stores cumulative text by message ID, and emits start/delta. `edit_message` compares the last cumulative value; prefix growth emits the suffix, replacement emits `{text, replace: true}`, and `finalize=True` emits completion.

`send_document` and `send_image_file` must call `self.validate_media_delivery_path(path)` before any open, then pass only sanitized metadata plus bytes to the connection.

`send_exec_approval` generates a request UUID, associates it with the currently active status tool call (or creates a new tool-call UUID when no status exists), stores request-to-session mapping, and emits all installed Hermes flags. `send_clarify` uses Hermes' `clarify_id` as the request ID and stores it until resolution.

- [ ] **Step 7: Implement tool and turn lifecycle hooks**

`set_status_text` is called from Hermes' worker thread. The first non-empty text schedules `tool.started` on the captured loop with a generated tool-call UUID; a changed non-empty text schedules `tool.progress` for that UUID; `None` schedules `tool.completed`. Never parse the human phrase into commands or arguments.

`on_processing_start` associates the `MessageEvent` with its connection. `on_processing_complete` maps `ProcessingOutcome.SUCCESS`, `FAILURE`, and `CANCELLED` to `turn.completed`, `turn.failed`, and `turn.cancelled`; successful payloads include the exact Hermes session key derived from the source. It then closes the per-turn connection after its terminal frame flushes.

`cancel_turn` computes the same Hermes session key used by `handle_message` and calls `cancel_session_processing(session_key, release_guard=True, discard_pending=True)`. Approval and clarification resolution call `resolve_gateway_approval` and `resolve_gateway_clarify` only after checking the request belongs to that live connection.

- [ ] **Step 8: Run all Python tests**

Run:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
integrations/hermes-bearcode/.venv/bin/python -m unittest discover -s integrations/hermes-bearcode/tests -v
```

Expected: all Python tests pass.

- [ ] **Step 9: Commit the plugin adapter**

```bash
git add integrations/hermes-bearcode
git commit -m "feat: register BearCode as a Hermes platform" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 5: Persist Explicit Native/Legacy Connection Mode and Secrets

**Files:**
- Modify: `src/shared/types.ts:1004-1032,1143-1240,1401-1405,1435-1440`
- Modify: `src/main/settings.ts:35-88,321-331`
- Modify: `src/main/settings.test.ts:145-175`
- Modify: `src/main/keys.ts:71-79`
- Modify: `src/main/keys.hermes.test.ts`
- Modify: `src/main/db/index.ts:276-285,394-490,944-949`
- Modify: `src/main/db/hermesSession.test.ts`
- Modify: `src/main/ipc.ts:607-612`
- Modify: `src/preload/index.ts:125-133,158-160`
- Modify: `src/renderer/src/state/store.ts:42-70,209-235,1331-1355`
- Modify: `src/renderer/src/state/store.test.ts`

**Interfaces:**
- Produces `HermesConnectionMode = 'native' | 'legacy'`.
- `ConversationMeta.hermesMode` is required and defaults old/unknown rows to `legacy`.
- `createHermes(mode)` persists the mode at conversation creation.
- Produces `getHermesPlatformKey`, `setHermesPlatformKey`, and `getOrCreateHermesInstallationId`.

- [ ] **Step 1: Write failing settings tests**

Add assertions:

```ts
expect(migrateSettings({}).hermesConnectionMode).toBe('legacy')
expect(migrateSettings({}).hermesNativeUrl).toBe('')
expect(migrateSettings({ hermesConnectionMode: 'native' }).hermesConnectionMode).toBe('native')
expect(migrateSettings({ hermesConnectionMode: 'bad' }).hermesConnectionMode).toBe('legacy')
expect(migrateSettings({ hermesNativeUrl: 42 }).hermesNativeUrl).toBe('')
```

- [ ] **Step 2: Write failing DB mode tests**

Extend mocked rows with `hermes_mode`. Assert NULL and unknown values return `legacy`, `native` returns `native`, and `setHermesMode('c1', 'native')` executes the expected update.

- [ ] **Step 3: Write failing vault tests**

Assert legacy bearer and native platform keys occupy different vault entries, clearing one does not clear the other, and `getOrCreateHermesInstallationId()` returns the same RFC 4122 UUID across repeated calls.

- [ ] **Step 4: Run focused tests to verify failure**

Run:

```bash
npx vitest run src/main/settings.test.ts src/main/keys.hermes.test.ts src/main/db/hermesSession.test.ts src/renderer/src/state/store.test.ts
```

Expected: failures for missing mode, URL, key, installation ID, and metadata.

- [ ] **Step 5: Add shared settings and conversation types**

Add:

```ts
export type HermesConnectionMode = 'native' | 'legacy'
```

Add required `hermesMode: HermesConnectionMode` to `ConversationMeta`; optional `hermesConnectionMode?: HermesConnectionMode` and `hermesNativeUrl?: string` to `AppSettings`; change `createHermes` to:

```ts
createHermes(mode: HermesConnectionMode): Promise<ConversationMeta>
```

- [ ] **Step 6: Add settings coercion**

Set defaults:

```ts
hermesConnectionMode: 'legacy',
hermesNativeUrl: '',
```

Coerce only exact `native`; every other value becomes `legacy`. Cap native URL at 500 characters, matching the legacy URL.

- [ ] **Step 7: Add separate native vault entries**

Use:

```ts
const HERMES_PLATFORM_KEY_VAULT_KEY = 'hermes:platformKey'
const HERMES_INSTALLATION_ID_VAULT_KEY = 'hermes:installationId'
```

Generate the installation ID with `randomUUID()`, store it through `setVaultSecret`, and never return it to renderer IPC.

- [ ] **Step 8: Add the DB column and creation contract**

Guard:

```sql
ALTER TABLE conversations ADD COLUMN hermes_mode TEXT
```

Add `hermes_mode` to `ConversationRow`, set `hermesMode` in `toMeta`, add `setHermesMode`, and change `create-hermes` IPC to validate the mode, mint a fresh session ID, and persist the chosen mode before returning metadata.

- [ ] **Step 9: Preserve mode in renderer state**

Add `hermesMode` to `Convo` and `fromMeta`. `newHermesConversation()` reads:

```ts
const mode = get().settings?.hermesConnectionMode === 'native' ? 'native' : 'legacy'
const meta = await window.bearcode.conversations.createHermes(mode)
```

- [ ] **Step 10: Run focused tests**

Run:

```bash
npx vitest run src/main/settings.test.ts src/main/keys.hermes.test.ts src/main/db/hermesSession.test.ts src/renderer/src/state/store.test.ts
npm run typecheck:node
npm run typecheck:web
```

Expected: all focused tests and both typechecks pass.

- [ ] **Step 11: Commit mode and secret persistence**

```bash
git add src/shared/types.ts src/main/settings.ts src/main/settings.test.ts src/main/keys.ts src/main/keys.hermes.test.ts src/main/db/index.ts src/main/db/hermesSession.test.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts
git commit -m "feat: persist Hermes native connection mode" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 6: Implement BearCode Native File Storage

**Files:**
- Modify: `src/main/attachments/ingest.ts:35-91,184-239`
- Modify: `src/main/attachments/ingest.test.ts`
- Create: `src/main/hermes/nativeFiles.ts`
- Create: `src/main/hermes/nativeFiles.test.ts`
- Modify: `src/main/ipc.ts:287-373`
- Modify: `src/main/ipc.test.ts`
- Modify: `src/preload/index.ts:97-103`
- Modify: `src/shared/types.ts:49-59,1360-1390`

**Interfaces:**
- Produces `describeNativeUpload(conversationId, ref)`.
- Produces `NativeDownloadWriter.begin`, `.append`, `.complete`, and `.abort`.
- Produces `deleteConversationAttachments(userDataDir, conversationId)` scoped to one validated conversation directory.
- Produces main-side `openAttachment(conversationId, attachmentId)`.
- Consumed by `HermesNativeTurn` in Task 7.

- [ ] **Step 1: Write failing upload-description tests**

Using a temporary userData directory, write a known file and assert:

```ts
expect(await describeNativeUpload(root, 'c1', {
  id: 'a1',
  name: 'note.txt',
  mime: 'text/plain',
  kind: 'text'
})).toEqual({
  id: 'a1',
  name: 'note.txt',
  declaredMime: 'text/plain',
  kind: 'text',
  sizeBytes: 4,
  sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
  path: expect.stringContaining('/attachments/c1/a1')
})
```

Assert traversal IDs, missing files, changed files above 10 MiB, and non-regular files reject before opening a stream.

- [ ] **Step 2: Write failing download-writer tests**

Test atomic completion, strict chunk order, declared-size enforcement, hash mismatch cleanup, duplicate IDs, abort-all cleanup, and filename/path non-use. Confirm final path is exactly `attachments/{conversationId}/{attachmentId}` and mode is `0o600`. Test conversation cleanup removes only the validated conversation directory and rejects traversal IDs.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npx vitest run src/main/hermes/nativeFiles.test.ts src/main/attachments/ingest.test.ts
```

Expected: module-not-found failure for `nativeFiles`.

- [ ] **Step 4: Export path-safe attachment validators**

Export `assertValidAttachmentId` from `ingest.ts`. Add `resolveStoredAttachmentPath(userDataDir, conversationId, id)` that validates both segments, resolves the expected path, and rejects any path whose parent differs from the validated conversation directory.

- [ ] **Step 5: Implement upload hashing and download writes**

Use Node streams and incremental `createHash('sha256')`; do not `readFile` a 10 MiB upload into a second buffer. Create `.partial-{uuid}` with `flags: 'wx'` and mode `0o600`, fsync/close, verify, then `rename`.

Map downloaded media kinds:

```ts
export type HermesAttachmentKind = 'image' | 'document' | 'text' | 'other'

export interface HermesAttachment {
  id: string
  name: string
  mime: string
  kind: HermesAttachmentKind
  sizeBytes: number
  sha256: string
}
```

The persisted metadata is exactly `{id,name,mime,kind,sizeBytes,sha256}`.

- [ ] **Step 6: Add safe attachment-open IPC**

Validate conversation/attachment IDs, resolve only the BearCode attachment store path, require a regular file, then call `shell.openPath`. Reject a non-empty result string as an error. Expose only:

```ts
attachments.open(conversationId: string, id: string): Promise<void>
```

Call `deleteConversationAttachments` from the existing conversation-delete path after the DB row is removed. In the full-clear path, capture the conversation IDs before clearing the DB, then remove each validated directory. This makes deletion reclaim both uploaded and downloaded files.

- [ ] **Step 7: Run file tests and typecheck**

Run:

```bash
npx vitest run src/main/hermes/nativeFiles.test.ts src/main/attachments/ingest.test.ts src/main/ipc.previewFile.test.ts src/main/ipc.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 8: Commit native file storage**

```bash
git add src/main/attachments/ingest.ts src/main/attachments/ingest.test.ts src/main/hermes/nativeFiles.ts src/main/hermes/nativeFiles.test.ts src/main/ipc.ts src/main/ipc.test.ts src/preload/index.ts src/shared/types.ts
git commit -m "feat: store verified Hermes attachments" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 7: Implement the Electron-Main Native WebSocket Client

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/hermes/nativeClient.ts`
- Create: `src/main/hermes/nativeClient.test.ts`

**Interfaces:**
- Consumes Task 1 protocol and Task 6 file storage.
- Produces `HermesNativeTurn`, `HermesNativeTurnOptions`, `HermesNativeClientError`, and `checkHermesNativeHealth`.
- Emits validated `HermesServerEvent` objects to Task 8's runner.

- [ ] **Step 1: Install the Node WebSocket dependency**

Run:

```bash
npm install ws
npm install --save-dev @types/ws
```

Expected: `package.json` and `package-lock.json` record `ws` and `@types/ws`. `ws` is required because the browser-style global WebSocket cannot attach the required `Authorization` upgrade header.

- [ ] **Step 2: Write failing connection-state tests**

Inject a fake `WebSocketFactory`. Cover:

- `Authorization: Bearer ${platformKey}` is present in constructor options;
- hello is the first outbound frame;
- incompatible handshake fails before uploads;
- attachments upload sequentially before `turn.start`;
- client waits for `attachment.upload.accepted`;
- binary frames match the fixture codec;
- server sequence gaps fail the turn;
- `turn.duplicate` surfaces a non-retryable already-accepted/already-finished error and never sends `turn.start` again;
- binary downloads must follow a matching begin event;
- connection failure retries once only before `turn.accepted`;
- disconnect after acceptance is never replayed;
- abort sends `turn.cancel` and closes after terminal/grace timeout;
- heartbeats echo nonce without touching turn state and a missed server heartbeat closes the client as `network.disconnected`.

- [ ] **Step 3: Run client tests to verify they fail**

Run:

```bash
npx vitest run src/main/hermes/nativeClient.test.ts
```

Expected: module-not-found failure for `nativeClient`.

- [ ] **Step 4: Implement the native turn API**

Expose:

```ts
export interface HermesNativeTurnOptions {
  url: string
  platformKey: string
  installationId: string
  conversationId: string
  turnId: string
  text: string
  attachments: AttachmentRef[]
  signal: AbortSignal
  onEvent: (event: HermesServerEvent) => void
  onAttachment: (attachment: HermesAttachment) => void
}

export interface NativeClientDeps {
  createWebSocket: (
    url: string,
    options: { headers: Record<string, string> }
  ) => import('ws').WebSocket
  userDataDir: string
  now: () => number
}

export class HermesNativeTurn {
  constructor(options: HermesNativeTurnOptions, deps?: NativeClientDeps)
  run(): Promise<'completed' | 'cancelled'>
  resolveApproval(requestId: string, decision: ApprovalDecision): void
  resolveClarification(requestId: string, response: string): void
  cancel(): void
  get accepted(): boolean
}
```

Normalize `http://` to `ws://` and `https://` to `wss://`, preserve an explicit `ws(s)://`, and append `/v1/bearcode` exactly once.

- [ ] **Step 5: Implement upload and download flow**

For each attachment:

1. call `describeNativeUpload`;
2. send `attachment.upload.begin`;
3. await matching accepted response;
4. stream at 256 KiB chunks with monotonically increasing chunk indexes;
5. wait for `attachment.upload.completed`.

For downloads, create `NativeDownloadWriter` on begin, append only `download` frames, verify on completed, then invoke `onAttachment` with the local verified metadata. Keep wire events immutable after Zod validation.

- [ ] **Step 6: Implement retry and error policy**

Use `HermesNativeClientError` with `kind`:

```ts
type HermesNativeErrorKind =
  | 'auth'
  | 'protocol'
  | 'network'
  | 'file'
  | 'hermes'
  | 'cancelled'
```

Retry one connection failure only when no `turn.accepted` has arrived. Once accepted, any close rejects with `network.disconnected`; the caller preserves partial output and never instantiates a replay turn.

- [ ] **Step 7: Implement native health check**

`checkHermesNativeHealth(url, key, installationId)` opens, sends hello with a generated probe conversation ID, validates `hello.accepted`, closes without `turn.start`, and returns the existing `{ok,message}` shape. Distinguish auth, incompatible protocol, and network errors.

- [ ] **Step 8: Run native-client tests**

Run:

```bash
npx vitest run src/main/hermes/nativeClient.test.ts src/main/hermes/protocol.test.ts src/main/hermes/nativeFiles.test.ts
npm run typecheck:node
```

Expected: all tests and node typecheck pass.

- [ ] **Step 9: Commit the native client**

```bash
git add package.json package-lock.json src/main/hermes/nativeClient.ts src/main/hermes/nativeClient.test.ts
git commit -m "feat: add Hermes native websocket client" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 8: Map Native Turns into BearCode Events and Orchestration

**Files:**
- Modify: `src/shared/types.ts:641-800,1401-1405`
- Create: `src/main/hermes/nativeRunner.ts`
- Create: `src/main/hermes/nativeRunner.test.ts`
- Modify: `src/main/orchestrator/hermes.ts:1-107`
- Modify: `src/main/orchestrator/hermes.test.ts`
- Modify: `src/main/orchestrator/graph.ts:3153-3164`
- Modify: `src/main/orchestrator/graph.test.ts:2263-2285`
- Modify: `src/main/orchestrator/index.ts:118-150,205-270`
- Modify: `src/main/ipc.ts:204-242,479-525`
- Modify: `src/preload/index.ts:57-78,115-133`

**Interfaces:**
- Produces native event variants `hermes_tool_call`, `hermes_tool_result`, `hermes_clarification`, and `assistant_attachment`.
- Produces `runHermesNative`, `cancelHermesNative`, `resolveHermesApproval`, and `resolveHermesClarification`.
- `runHermes` dispatches by persisted `ConversationMeta.hermesMode`.

- [ ] **Step 1: Add exact native Event variants**

Add:

```ts
| {
    type: 'hermes_tool_call'
    id: string
    name: string
    label: string
    status: 'running' | 'awaiting-approval' | 'completed' | 'failed'
    requestId?: string
    command?: string
    description?: string
    allowSession?: boolean
    allowPermanent?: boolean
    smartDenied?: boolean
    approvalDecision?: ApprovalDecision
  }
| {
    type: 'hermes_tool_result'
    id: string
    callId: string
    status: 'completed' | 'failed'
    message?: string
    durationMs: number
  }
| {
    type: 'hermes_clarification'
    id: string
    requestId: string
    question: string
    choices: string[]
    state: 'pending' | 'answered'
    response?: string
  }
| {
    type: 'assistant_attachment'
    id: string
    attachment: HermesAttachment
  }
```

- [ ] **Step 2: Write failing runner tests**

Mock `HermesNativeTurn` and assert:

- assistant deltas re-emit cumulative `assistant_text` with one stable ID;
- assistant completion persists the final text once;
- failure after deltas persists partial text before the error;
- tool start/progress replace one `hermes_tool_call`;
- completion persists call plus result;
- approval request becomes a pending tool card and resolution is routed to the active turn;
- clarification is live-pending, then persisted answered;
- downloaded attachment is persisted as `assistant_attachment`;
- terminal completion persists the returned Hermes session ID, emits `turn_meta` with provider `hermes` and model `agent`, and closes done;
- failure/cancel map to error/cancelled without automatic replay;
- one active native turn per conversation is enforced.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npx vitest run src/main/hermes/nativeRunner.test.ts src/main/orchestrator/hermes.test.ts src/main/orchestrator/graph.test.ts
```

Expected: failures for missing native event types and runner.

- [ ] **Step 4: Implement `nativeRunner`**

Maintain:

```ts
const activeTurns = new Map<string, {
  turn: HermesNativeTurn
  pendingApprovals: Set<string>
  pendingClarifications: Set<string>
  toolStartedAt: Map<string, number>
}>()
```

Export these exact entry points:

```ts
export function runHermesNative(
  conversationId: string,
  userText: string,
  attachments: AttachmentRef[],
  sink: RunSink,
  signal: AbortSignal
): Promise<{ paused: false; failed?: boolean }>

export function cancelHermesNative(conversationId: string): boolean
export function resolveHermesApproval(
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision
): boolean
export function resolveHermesClarification(
  conversationId: string,
  requestId: string,
  response: string
): boolean
```

Use `appendOrReplaceEvent` for Hermes tool updates. Pending approval/clarification cards are emitted live immediately; persist them only when resolved so a BearCode crash cannot leave an actionable card for a dead connection.

Track each `tool.started` timestamp in the active-turn record and compute `hermes_tool_result.durationMs` at completion; default to `0` only when a completion arrives without a matching start.

On terminal failure, persist the latest cumulative assistant text if it has not been persisted, then append one recoverable `error`.

On `turn.completed`, call `setHermesSessionId(conversationId, payload.sessionId)` and emit the refreshed conversation metadata through `sink.metaChanged`.

- [ ] **Step 5: Split native and legacy Hermes dispatch**

Change `runHermes` signature to:

```ts
runHermes(
  conversationId: string,
  userText: string,
  attachments: AttachmentRef[],
  sink: RunSink,
  signal: AbortSignal
)
```

Read `meta.hermesMode`. Legacy mode calls the unchanged `sendHermesMessage` path and rejects non-empty attachments with a clear error. Native mode requires `hermesNativeUrl`, platform key, and installation ID, then calls `runHermesNative`.

- [ ] **Step 6: Pass attachments from the graph seam**

At the Hermes branch in `graph.ts`, call:

```ts
return runHermes(conversationId, userText, attachments, sink, signal)
```

Update the route test to assert the exact attachment array reaches `runHermes`.

- [ ] **Step 7: Route cancellation and interactions**

`cancelRunOrchestrator` must call `cancelHermesNative(conversationId)` before the local approval cleanup. Add IPC:

```ts
hermes.resolveApproval(
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision
): Promise<void>

hermes.resolveClarification(
  conversationId: string,
  requestId: string,
  response: string
): Promise<void>
```

Validate conversation/request IDs and decisions main-side before routing.

- [ ] **Step 8: Run orchestration tests**

Run:

```bash
npx vitest run src/main/hermes/nativeRunner.test.ts src/main/orchestrator/hermes.test.ts src/main/orchestrator/graph.test.ts src/main/ipc.hermes.test.ts src/preload/index.test.ts
npm run typecheck:node
```

Expected: all focused tests and node typecheck pass.

- [ ] **Step 9: Commit native orchestration**

```bash
git add src/shared/types.ts src/main/hermes/nativeRunner.ts src/main/hermes/nativeRunner.test.ts src/main/orchestrator/hermes.ts src/main/orchestrator/hermes.test.ts src/main/orchestrator/graph.ts src/main/orchestrator/graph.test.ts src/main/orchestrator/index.ts src/main/ipc.ts src/preload/index.ts src/main/ipc.hermes.test.ts src/preload/index.test.ts
git commit -m "feat: route Hermes native turns through BearCode" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 9: Render Hermes Tools, Approvals, Clarifications, and Attachments

**Files:**
- Modify: `src/renderer/src/lib/transcript.ts:3-90,102-128`
- Modify: `src/renderer/src/lib/transcript.test.ts`
- Create: `src/renderer/src/components/events/HermesToolStep.tsx`
- Create: `src/renderer/src/components/events/HermesToolStep.test.tsx`
- Create: `src/renderer/src/components/events/HermesClarifyCard.tsx`
- Create: `src/renderer/src/components/events/HermesClarifyCard.test.tsx`
- Create: `src/renderer/src/components/events/HermesAttachment.tsx`
- Create: `src/renderer/src/components/events/HermesAttachment.test.tsx`
- Modify: `src/renderer/src/components/events/WorkedGroup.tsx:13-115`
- Modify: `src/renderer/src/components/ConversationView.tsx:122-142,283-390,430-447`
- Modify: `src/renderer/src/components/ConversationView.test.tsx`
- Modify: `src/renderer/src/state/store.ts:360-440,1028-1080`

**Interfaces:**
- Consumes native Event variants from Task 8.
- Store exposes `resolveHermesApproval` and `resolveHermesClarification`.
- Transcript adds `attachments` and `clarifications` buckets; Hermes tool events stay in `steps`.

- [ ] **Step 1: Write failing transcript tests**

Create a turn containing all four new event types. Assert:

```ts
expect(turn.steps.map((event) => event.type)).toEqual([
  'hermes_tool_call',
  'hermes_tool_result'
])
expect(turn.clarifications).toHaveLength(1)
expect(turn.attachments).toHaveLength(1)
```

Also verify `sameTranscriptItem` detects changes in both new buckets.

- [ ] **Step 2: Write failing component tests**

Pin:

- arbitrary tool name and label render without coercion to local `ToolName`;
- completed tool renders duration/status;
- pending approval shows only allowed choices;
- clicking Allow Once routes `('conversation-id', 'request-id', 'once')`;
- Deny routes `deny`;
- clarification choices route their exact string;
- Other exposes a required text input;
- image attachment loads through `attachments.read`;
- document attachment shows type badge and calls `attachments.open`.

- [ ] **Step 3: Run renderer tests to verify failure**

Run:

```bash
npx vitest run src/renderer/src/lib/transcript.test.ts src/renderer/src/components/events/HermesToolStep.test.tsx src/renderer/src/components/events/HermesClarifyCard.test.tsx src/renderer/src/components/events/HermesAttachment.test.tsx src/renderer/src/components/ConversationView.test.tsx
```

Expected: missing components/types and failed bucket assertions.

- [ ] **Step 4: Extend transcript grouping**

Add Hermes tool call/result events to the existing `steps: Event[]` bucket so ordering with thinking and local step rows remains stable. Add only these new turn buckets:

```ts
clarifications: Extract<Event, { type: 'hermes_clarification' }>[]
attachments: Extract<Event, { type: 'assistant_attachment' }>[]
```

Include both arrays in `sameTranscriptItem`.

- [ ] **Step 5: Implement `HermesToolStep`**

Pair `hermes_tool_result.callId` to the call in `WorkedGroup`, exactly as local tool results are paired. Render a passive status row for running/completed/failed. For awaiting approval, render the command in a code block, description, and buttons:

```ts
const decisions: Array<{ decision: ApprovalDecision; label: string }> = [
  { decision: 'once', label: 'Allow Once' },
  ...(call.allowSession ? [{ decision: 'session' as const, label: 'Allow Session' }] : []),
  ...(call.allowPermanent ? [{ decision: 'always' as const, label: 'Always Allow' }] : []),
  { decision: 'deny', label: 'Deny' }
]
```

- [ ] **Step 6: Implement clarification and attachment components**

`HermesClarifyCard` disables itself after submission and calls store resolution once. `HermesAttachment` uses the existing attachment badge, lazy-loads images through `attachments.read`, and opens non-images only through `attachments.open`.

- [ ] **Step 7: Pin the first pending native interaction**

In `ConversationView`, select the first pending Hermes approval or clarification in event order. Render one interactive pinned copy above the composer. Keep transcript copies passive so one click cannot resolve twice.

- [ ] **Step 8: Run renderer tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/lib/transcript.test.ts src/renderer/src/components/events/HermesToolStep.test.tsx src/renderer/src/components/events/HermesClarifyCard.test.tsx src/renderer/src/components/events/HermesAttachment.test.tsx src/renderer/src/components/ConversationView.test.tsx
npm run typecheck:web
```

Expected: focused tests and web typecheck pass.

- [ ] **Step 9: Commit native interaction UI**

```bash
git add src/renderer/src/lib/transcript.ts src/renderer/src/lib/transcript.test.ts src/renderer/src/components/events/HermesToolStep.tsx src/renderer/src/components/events/HermesToolStep.test.tsx src/renderer/src/components/events/HermesClarifyCard.tsx src/renderer/src/components/events/HermesClarifyCard.test.tsx src/renderer/src/components/events/HermesAttachment.tsx src/renderer/src/components/events/HermesAttachment.test.tsx src/renderer/src/components/events/WorkedGroup.tsx src/renderer/src/components/ConversationView.tsx src/renderer/src/components/ConversationView.test.tsx src/renderer/src/state/store.ts
git commit -m "feat: render Hermes native interactions" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 10: Expose Native Mode in Settings and Composer

**Files:**
- Modify: `src/main/ipc.ts:520-525`
- Modify: `src/main/ipc.hermes.test.ts`
- Modify: `src/preload/index.ts:125-133`
- Modify: `src/shared/types.ts:1401-1405`
- Modify: `src/renderer/src/state/store.ts:432-435,1353-1355`
- Modify: `src/renderer/src/components/Settings/pages/HermesPage.tsx:15-153`
- Modify: `src/renderer/src/components/Settings/pages/HermesPage.test.tsx`
- Modify: `src/renderer/src/components/Composer/Composer.tsx:140-180,318-365,571-730`
- Modify: `src/renderer/src/components/Composer/Composer.test.tsx`
- Modify: `src/renderer/src/components/Composer/AddContextMenu.test.tsx`

**Interfaces:**
- `testHermesConnection(mode, url, secret?)` dispatches to native handshake or legacy `/v1/models`.
- Native Hermes composer exposes only Media plus voice.
- Legacy Hermes remains text-only.

- [ ] **Step 1: Write failing settings-page tests**

Assert:

- mode defaults to Legacy API for migrated settings;
- selecting Native Platform persists `hermesConnectionMode: 'native'`;
- native mode displays Native WebSocket URL and Platform key;
- legacy mode displays Gateway URL and Bearer token;
- native Test Connection calls `(native, nativeUrl, platformKey)`;
- legacy Test Connection calls `(legacy, gatewayUrl, bearerToken)`;
- blank draft secrets make main use the already-vaulted secret for that mode;
- failed native handshake copy distinguishes missing plugin, bad key, and protocol mismatch.

- [ ] **Step 2: Write failing composer tests**

For a native Hermes conversation:

- Add Context button exists;
- opening it shows only Media;
- Media invokes the existing picker;
- mentions, actions, browser, slash, model, mode, and effort controls remain absent;
- mic remains present.

For a legacy Hermes conversation:

- Add Context remains absent;
- attachments cannot be selected;
- mic remains present.

- [ ] **Step 3: Run focused UI tests to verify failure**

Run:

```bash
npx vitest run src/renderer/src/components/Settings/pages/HermesPage.test.tsx src/renderer/src/components/Composer/Composer.test.tsx src/renderer/src/components/Composer/AddContextMenu.test.tsx src/main/ipc.hermes.test.ts
```

Expected: failures for missing mode-specific behavior.

- [ ] **Step 4: Route mode-specific connection testing**

Change typed API:

```ts
testConnection(
  mode: HermesConnectionMode,
  url: string,
  secret?: string
): Promise<{ ok: boolean; message: string }>
setLegacyToken(token: string): Promise<void>
setPlatformKey(key: string): Promise<void>
```

Main IPC validates the mode and calls either `checkHermesHealth` or `checkHermesNativeHealth`. When the renderer supplies no draft secret, main reads the appropriate stored legacy token or native platform key from the vault. Native health uses the main-side installation ID and never sends it to renderer.

- [ ] **Step 5: Implement explicit Settings UI**

Use a two-option segmented control or select with labels exactly `Native Platform` and `Legacy API`. Keep separate draft values for the URLs and secrets so switching modes cannot overwrite the other mode's stored configuration.

Native explanatory copy must say BearCode must be open and the plugin must be installed on Hermes. Legacy copy must state text-only and no file/approval guarantees.

- [ ] **Step 6: Gate composer capabilities by persisted conversation mode**

Compute:

```ts
const isNativeHermes = isHermesConvo && activeConvo?.hermesMode === 'native'
const addContextGroupsForConversation = isNativeHermes
  ? [{ items: [{ value: 'media', label: 'Media', icon: <IconPaperclip /> }] }]
  : addContextGroups
```

Render Add Context for non-Hermes or native Hermes. Keep mention/slash handlers disabled for every Hermes conversation.

- [ ] **Step 7: Run UI tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/components/Settings/pages/HermesPage.test.tsx src/renderer/src/components/Composer/Composer.test.tsx src/renderer/src/components/Composer/AddContextMenu.test.tsx src/main/ipc.hermes.test.ts src/preload/index.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 8: Commit settings and composer mode UI**

```bash
git add src/main/ipc.ts src/main/ipc.hermes.test.ts src/preload/index.ts src/preload/index.test.ts src/shared/types.ts src/renderer/src/state/store.ts src/renderer/src/components/Settings/pages/HermesPage.tsx src/renderer/src/components/Settings/pages/HermesPage.test.tsx src/renderer/src/components/Composer/Composer.tsx src/renderer/src/components/Composer/Composer.test.tsx src/renderer/src/components/Composer/AddContextMenu.test.tsx
git commit -m "feat: expose Hermes native platform mode" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 11: Add a Real Cross-Language Integration Harness

**Files:**
- Create: `integrations/hermes-bearcode/tests/harness_server.py`
- Create: `src/main/hermes/nativeIntegration.test.ts`
- Create: `integrations/hermes-bearcode/README.md`

**Interfaces:**
- Uses the real Python protocol/server/connection and real TypeScript `HermesNativeTurn`.
- Fake delegate deterministically exercises text, tool status, approval, clarification, upload, download, cancellation, and failure.

- [ ] **Step 1: Implement the deterministic Python harness**

The harness reads `BEARCODE_TEST_PORT` and `BEARCODE_PLATFORM_KEY`, starts the real `BearCodeServer`, and supplies a fake delegate with commands selected by user text:

```text
text        -> stream "Hel" then "lo", complete
tool        -> tool.started, tool.completed, complete
approve     -> approval.requested, wait for once, complete
clarify     -> clarification.requested, wait for response, echo response
download    -> stream four known bytes as analysis.pdf, complete
cancel      -> wait until turn.cancel, emit cancelled
fail        -> stream "partial", emit turn.failed
```

For upload, assert cached test bytes hash correctly and return their filename in assistant text.

- [ ] **Step 2: Write the integration test**

Spawn with:

```ts
const child = spawn('integrations/hermes-bearcode/.venv/bin/python', [
  'integrations/hermes-bearcode/tests/harness_server.py'
], {
  env: {
    ...process.env,
    PYTHONPATH: 'integrations/hermes-bearcode',
    BEARCODE_TEST_PORT: String(port),
    BEARCODE_PLATFORM_KEY: 'integration-secret'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
```

Wait for one `READY\n` line, then execute all seven commands through the real client. Use temporary userData directories and verify downloaded bytes on disk.

- [ ] **Step 3: Run the harness**

Run:

```bash
npx vitest run src/main/hermes/nativeIntegration.test.ts
```

Expected: all cross-language cases pass and the child process exits cleanly.

- [ ] **Step 4: Document local development commands**

README must include:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
integrations/hermes-bearcode/.venv/bin/python -m unittest discover -s integrations/hermes-bearcode/tests -v

npx vitest run src/main/hermes/protocol.test.ts \
  src/main/hermes/nativeFiles.test.ts \
  src/main/hermes/nativeClient.test.ts \
  src/main/hermes/nativeRunner.test.ts \
  src/main/hermes/nativeIntegration.test.ts
```

State explicitly that the fakes test adapter contracts but the final compatibility check imports the real installed Hermes modules.

- [ ] **Step 5: Commit the integration harness**

```bash
git add integrations/hermes-bearcode/tests/harness_server.py integrations/hermes-bearcode/README.md src/main/hermes/nativeIntegration.test.ts
git commit -m "test: cover Hermes native integration end to end" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 12: Add Upgrade-Safe Deployment, Compatibility, and Rollback

**Files:**
- Create: `integrations/hermes-bearcode/scripts/check-compatibility.py`
- Create: `integrations/hermes-bearcode/scripts/healthcheck.py`
- Create: `integrations/hermes-bearcode/scripts/install-local.sh`
- Create: `integrations/hermes-bearcode/tests/test_scripts.py`
- Modify: `integrations/hermes-bearcode/README.md`

**Interfaces:**
- `check-compatibility.py` exits nonzero before installation if installed Hermes lacks a required public hook.
- `install-local.sh /tmp/hermes-bearcode-stage` atomically installs, enables, restarts, checks, and rolls back.
- The script must run as the Hermes service user/root on `umzspark`.

- [ ] **Step 1: Write failing script tests**

Using a temporary fake `$HERMES_HOME` and fake command directory, test:

- non-root/current-service-user mismatch refuses;
- missing `BasePlatformAdapter` hooks refuses before copy;
- stage without `plugin.yaml`/`adapter.py` refuses;
- successful install keeps a timestamped previous version;
- failed health check restores the previous version;
- `.env` permissions remain `0o600`;
- plugin key is generated only when absent;
- source and destination paths are validated and never empty/root.

- [ ] **Step 2: Run script tests to verify failure**

Run:

```bash
integrations/hermes-bearcode/.venv/bin/python -m unittest integrations/hermes-bearcode/tests/test_scripts.py -v
```

Expected: missing script failures.

- [ ] **Step 3: Implement compatibility checks**

Import real Hermes modules and assert:

```python
REQUIRED_BASE_METHODS = {
    "connect",
    "disconnect",
    "send",
    "edit_message",
    "send_document",
    "send_image_file",
    "send_clarify",
    "handle_message",
    "build_source",
    "on_processing_start",
    "on_processing_complete",
    "validate_media_delivery_path",
}
```

Also import `MessageEvent`, `MessageType`, `ProcessingOutcome`, `SendResult`, `cache_media_bytes`, `resolve_gateway_approval`, and `resolve_gateway_clarify`; load `adapter.py`; call `register` against a recording context; verify the registered name is `bearcode`.

- [ ] **Step 4: Implement authenticated health check**

Use `aiohttp.ClientSession.ws_connect` with Authorization header, send the canonical hello, require `hello.accepted` version 1 and attachment limits, then close without starting a turn. Accept URL/key via environment variables so the key never appears in process arguments.

- [ ] **Step 5: Implement atomic install and rollback**

`install-local.sh` must:

1. require an explicit existing stage directory;
2. resolve `$HERMES_HOME` and reject empty, `/`, or non-owned paths;
3. run all Python tests against the staged source;
4. run `check-compatibility.py` with `/usr/local/lib/hermes-agent` on `PYTHONPATH`;
5. copy into `$HERMES_HOME/plugins/platforms/bearcode.next` with mode `0700`;
6. generate a 32-byte hex key into `$HERMES_HOME/.env` only if absent;
7. default host from `tailscale ip -4` and port to `8643`;
8. ensure `BEARCODE_ALLOW_ALL_USERS=true` because the bearer gate authenticates the installation;
9. move current `bearcode` to `bearcode.previous`;
10. move `.next` to `bearcode`;
11. run `hermes plugins enable bearcode-platform`;
12. restart `hermes-gateway.service`;
13. run the authenticated health check;
14. on failure restore `bearcode.previous`, restart, and exit nonzero;
15. on success retain only the immediately previous plugin directory.

- [ ] **Step 6: Run deployment-script tests**

Run:

```bash
integrations/hermes-bearcode/.venv/bin/python -m unittest integrations/hermes-bearcode/tests/test_scripts.py -v
shellcheck integrations/hermes-bearcode/scripts/install-local.sh
```

Expected: Python tests pass and ShellCheck reports no findings. On macOS, install a missing ShellCheck first with `brew install shellcheck`.

- [ ] **Step 7: Document the current two-hop deployment**

Document staging from the BearCode workspace:

```bash
tar -C integrations/hermes-bearcode -czf /tmp/hermes-bearcode-plugin.tgz .
scp -o ProxyJump=umzcaio /tmp/hermes-bearcode-plugin.tgz zach@umzspark:/tmp/hermes-bearcode-plugin.tgz
ssh -o BatchMode=yes umzcaio
sudo -i
ssh umzspark
mkdir -p /tmp/hermes-bearcode-stage
tar -C /tmp/hermes-bearcode-stage -xzf /tmp/hermes-bearcode-plugin.tgz
HERMES_HOME=/root/.hermes /tmp/hermes-bearcode-stage/scripts/install-local.sh /tmp/hermes-bearcode-stage
```

Also document how to read the generated platform key once for entry into BearCode Settings without copying it into repository files or shell history.

- [ ] **Step 8: Commit deployment tooling**

```bash
git add integrations/hermes-bearcode/scripts integrations/hermes-bearcode/tests/test_scripts.py integrations/hermes-bearcode/README.md
git commit -m "ops: deploy Hermes BearCode plugin safely" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>"
```

### Task 13: Full Verification and `umzspark` Acceptance

**Files:**
- Modify only if a verification failure reveals a defect; add a focused regression test beside every fix.

**Interfaces:**
- Verifies the complete design and produces no new runtime contract.

- [ ] **Step 1: Run all local Python tests**

Run:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
integrations/hermes-bearcode/.venv/bin/python -m unittest discover -s integrations/hermes-bearcode/tests -v
```

Expected: zero failures and zero errors.

- [ ] **Step 2: Run the complete BearCode test suite**

Run:

```bash
npm test
```

Expected: all Vitest files pass.

- [ ] **Step 3: Run static gates**

Run:

```bash
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Deploy to `umzspark`**

Follow Task 12's documented two-hop deployment from a clean committed source tree. Confirm:

```bash
systemctl is-active hermes-gateway.service
set -a
. /root/.hermes/.env
set +a
HERMES_HOME=/root/.hermes \
BEARCODE_NATIVE_URL="ws://$(tailscale ip -4):8643/v1/bearcode" \
/usr/local/lib/hermes-agent/venv/bin/python \
/root/.hermes/plugins/platforms/bearcode/scripts/healthcheck.py
```

Expected: service is `active`; health check reports protocol 1 and exits 0.

- [ ] **Step 5: Execute the interactive acceptance matrix**

In a new Native Platform conversation:

1. stream a normal text response;
2. observe a Hermes tool start and completion;
3. approve an Allow Once request;
4. deny a second request;
5. answer a choice clarification;
6. answer a free-text clarification;
7. upload PNG, PDF, text/code, DOCX, and XLSX examples;
8. receive and open a generated image;
9. receive and open a generated document;
10. cancel a long-running turn;
11. force a mid-turn disconnect and verify partial text plus one error;
12. restart BearCode and reopen prior text and downloaded attachments;
13. restart the Hermes gateway and continue the same conversation/session;
14. open two conversations and run one turn in each concurrently;
15. attempt two simultaneous turns in one conversation and verify rejection;
16. disable the plugin and verify Native Platform reports a clear plugin/network error;
17. choose Legacy API and verify `:8642` text chat still works.

- [ ] **Step 6: Verify the upgrade boundary**

On `umzspark`, run:

```bash
git -c safe.directory=/usr/local/lib/hermes-agent \
  -C /usr/local/lib/hermes-agent status --short
```

Expected: no changes. Confirm the only deployed BearCode server code is under `/root/.hermes/plugins/platforms/bearcode/`.

- [ ] **Step 7: Run a rollback drill**

Deliberately stage a plugin whose health check cannot pass by using an invalid test port in the temporary stage configuration. Run the installer and verify:

- it exits nonzero;
- `bearcode.previous` is restored;
- gateway returns active;
- authenticated health check passes against the restored plugin.

Restore the valid environment value before ending the drill.

- [ ] **Step 8: Commit only regression fixes, if any**

For each defect found, run its focused failing test before the fix and passing test after the fix. Stage only the named regression test and its corresponding fix, then commit with subject `fix: harden Hermes native acceptance path` and the required co-author footer.

If no defects were found, do not create an empty commit.

## Completion Criteria

- The plugin is discovered from `/root/.hermes/plugins/platforms/bearcode/`.
- `/usr/local/lib/hermes-agent` remains clean.
- BearCode native and legacy modes are explicit and persisted per conversation.
- Text, tool activity, approvals, clarifications, and supported files work bidirectionally.
- Attachments survive BearCode restart and contain verified bytes.
- Cancellation/disconnect never replay an accepted turn.
- Local unit, integration, lint, typecheck, and build gates pass.
- The `umzspark` smoke matrix and rollback drill pass.
