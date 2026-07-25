"""Authenticated BearCode WebSocket connection lifecycle."""
import asyncio
import json
import secrets
from enum import Enum, auto
from pathlib import Path
from typing import Optional, Protocol
from uuid import UUID, uuid4

from aiohttp import WSCloseCode, WSMsgType

from .ledger import LedgerCapacityError, TurnLedger
from .protocol import (
    MAX_FILES,
    MAX_FILE_BYTES,
    MAX_CHUNK_BYTES,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    ProtocolViolation,
    decode_binary_frame,
    decode_client_event,
    encode_event,
)
from .security import validate_outbound_path
from .transfers import (
    OutboundSnapshotCleanupOwner,
    UploadTransfer,
    VerifiedUpload,
    VerifiedUploadCleanupOwner,
    create_outbound_snapshot,
    iter_download_frames,
)


class ConnectionState(Enum):
    CONNECTED = auto()
    HELLO = auto()
    UPLOADING = auto()
    READY = auto()
    ACCEPTED = auto()
    TERMINAL = auto()
    CLOSED = auto()


class TurnDelegate(Protocol):
    async def start_turn(
        self,
        connection: "BearCodeConnection",
        event: dict,
        uploads: list[VerifiedUpload],
    ) -> None:
        ...

    async def cancel_turn(self, connection: "BearCodeConnection") -> None:
        ...

    async def resolve_approval(
        self,
        connection: "BearCodeConnection",
        request_id: str,
        decision: str,
    ) -> bool:
        ...

    async def resolve_clarification(
        self,
        connection: "BearCodeConnection",
        request_id: str,
        response: str,
    ) -> bool:
        ...


class ConnectionRegistry:
    def __init__(self, ledger: TurnLedger):
        self.ledger = ledger
        self._connections = {}
        self._lock = asyncio.Lock()

    async def claim(
        self,
        conversation_id: UUID,
        connection: "BearCodeConnection",
    ) -> bool:
        key = str(conversation_id)
        async with self._lock:
            if key in self._connections:
                return False
            self._connections[key] = connection
            return True

    async def release(
        self,
        conversation_id: UUID,
        connection: "BearCodeConnection",
    ) -> None:
        key = str(conversation_id)
        async with self._lock:
            if self._connections.get(key) is connection:
                self._connections.pop(key, None)

    async def get(
        self,
        conversation_id: str,
    ) -> Optional["BearCodeConnection"]:
        async with self._lock:
            return self._connections.get(str(conversation_id))


class BearCodeConnection:
    HEARTBEAT_INTERVAL_SECONDS = 15
    HEARTBEAT_TIMEOUT_SECONDS = 30
    PRETURN_TIMEOUT_SECONDS = 60

    def __init__(
        self,
        websocket,
        registry: ConnectionRegistry,
        delegate: TurnDelegate,
        temp_root: Path,
        *,
        outbound_roots=None,
        snapshot_cleanup_owner=None,
        verified_upload_cleanup_owner=None,
        heartbeat_interval=None,
        heartbeat_timeout=None,
        preturn_timeout=None,
    ):
        self.websocket = websocket
        self.registry = registry
        self.delegate = delegate
        self.temp_root = Path(temp_root)
        self.outbound_roots = tuple(
            Path(root)
            for root in (
                [self.temp_root]
                if outbound_roots is None
                else outbound_roots
            )
        )
        self._snapshot_cleanup_owner = (
            OutboundSnapshotCleanupOwner()
            if snapshot_cleanup_owner is None
            else snapshot_cleanup_owner
        )
        self._verified_upload_cleanup_owner = (
            VerifiedUploadCleanupOwner()
            if verified_upload_cleanup_owner is None
            else verified_upload_cleanup_owner
        )
        self.connection_id = uuid4()
        self.state = ConnectionState.CONNECTED
        self.conversation_id = None
        self.installation_id = None
        self.turn_id = None

        self._heartbeat_interval = (
            self.HEARTBEAT_INTERVAL_SECONDS
            if heartbeat_interval is None
            else heartbeat_interval
        )
        self._heartbeat_timeout = (
            self.HEARTBEAT_TIMEOUT_SECONDS
            if heartbeat_timeout is None
            else heartbeat_timeout
        )
        self._preturn_timeout = (
            self.PRETURN_TIMEOUT_SECONDS
            if preturn_timeout is None
            else preturn_timeout
        )
        self._loop = None
        self._heartbeat_task = None
        self._preturn_task = None
        self._pending_heartbeats = {}
        self._active_uploads = {}
        self._verified_uploads = {}
        self._upload_turn_id = None
        self._sequence = 0
        self._send_lock = asyncio.Lock()
        self._terminal_lock = asyncio.Lock()
        self._cleanup_lock = asyncio.Lock()
        self._outbound_reservation_lock = asyncio.Lock()
        self._outbound_attachment_ids = set()
        self._cleaned = False
        self._cancel_started = False

    async def run(self):
        self._loop = asyncio.get_running_loop()
        try:
            message = await self.websocket.receive()
            if message.type is not WSMsgType.TEXT:
                raise ProtocolViolation("first frame must be hello")
            hello = self._decode_hello(message.data)
            if PROTOCOL_VERSION not in hello["versions"]:
                await self._send_hello_rejected(
                    "protocol.unsupported_version",
                    "No mutually supported protocol version.",
                )
                await self.websocket.close()
                return

            conversation_id = UUID(hello["conversationId"])
            if not await self.registry.claim(conversation_id, self):
                await self._send_hello_rejected(
                    "plugin.conversation_busy",
                    "This conversation already has an active connection.",
                )
                await self.websocket.close()
                return

            self.conversation_id = conversation_id
            self.installation_id = UUID(hello["installationId"])
            self.state = ConnectionState.HELLO
            await self._send_hello_accepted()
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            self._preturn_task = asyncio.create_task(
                self._preturn_deadline()
            )

            while not self.websocket.closed:
                message = await self.websocket.receive()
                if message.type is WSMsgType.TEXT:
                    event = decode_client_event(message.data)
                    await self._handle_event(event)
                elif message.type is WSMsgType.BINARY:
                    await self._handle_binary(message.data)
                elif message.type in {
                    WSMsgType.CLOSE,
                    WSMsgType.CLOSED,
                    WSMsgType.CLOSING,
                    WSMsgType.ERROR,
                }:
                    break
                else:
                    raise ProtocolViolation("unsupported WebSocket frame")
        except (ProtocolViolation, ValueError, json.JSONDecodeError):
            if not self.websocket.closed:
                await self.websocket.close(
                    code=WSCloseCode.PROTOCOL_ERROR,
                    message=b"protocol violation",
                )
        finally:
            await self._cleanup()

    @staticmethod
    def _decode_hello(raw):
        try:
            event = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as error:
            raise ProtocolViolation("invalid hello frame") from error
        required = {
            "type",
            "protocol",
            "versions",
            "client",
            "conversationId",
            "installationId",
        }
        if not isinstance(event, dict) or not required.issubset(event):
            raise ProtocolViolation("first frame must be hello")
        if event["type"] != "hello" or event["protocol"] != PROTOCOL_NAME:
            raise ProtocolViolation("first frame must be hello")
        versions = event["versions"]
        if (
            not isinstance(versions, list)
            or any(
                not isinstance(version, int) or isinstance(version, bool)
                for version in versions
            )
        ):
            raise ProtocolViolation("hello versions must be integers")
        client = event["client"]
        if (
            not isinstance(client, dict)
            or not isinstance(client.get("name"), str)
            or not isinstance(client.get("version"), str)
        ):
            raise ProtocolViolation("invalid hello client")
        try:
            UUID(event["conversationId"])
            UUID(event["installationId"])
        except (ValueError, TypeError, AttributeError):
            raise ProtocolViolation("invalid hello UUID") from None
        return event

    async def _send_hello_accepted(self):
        await self._send_raw(
            {
                "type": "hello.accepted",
                "protocol": PROTOCOL_NAME,
                "version": PROTOCOL_VERSION,
                "connectionId": str(self.connection_id),
                "capabilities": {
                    "streaming": True,
                    "toolProgress": True,
                    "approvals": True,
                    "clarifications": True,
                    "attachments": {
                        "upload": True,
                        "download": True,
                        "maxFiles": MAX_FILES,
                        "maxBytesPerFile": MAX_FILE_BYTES,
                        "maxChunkBytes": MAX_CHUNK_BYTES,
                    },
                },
            }
        )

    async def _send_hello_rejected(self, code, message):
        await self._send_raw(
            {
                "type": "hello.rejected",
                "protocol": PROTOCOL_NAME,
                "supportedVersions": [PROTOCOL_VERSION],
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": False,
                },
            }
        )

    async def _send_raw(self, event):
        async with self._send_lock:
            await self.websocket.send_str(encode_event(event))

    async def _handle_event(self, event):
        event_type = event["type"]
        if event_type == "heartbeat":
            self._pending_heartbeats.pop(event["nonce"], None)
            return
        if event_type == "attachment.upload.begin":
            await self._begin_upload(event)
            return
        if event_type == "turn.start":
            await self._start_turn(event)
            return
        if event_type == "approval.resolve":
            self._require_active_turn(event)
            await self.delegate.resolve_approval(
                self,
                event["requestId"],
                event["decision"],
            )
            return
        if event_type == "clarification.resolve":
            self._require_active_turn(event)
            await self.delegate.resolve_clarification(
                self,
                event["requestId"],
                event["response"],
            )
            return
        if event_type == "turn.cancel":
            self._require_active_turn(event)
            await self._cancel_from_client()
            return
        raise ProtocolViolation("unsupported client event")

    async def _begin_upload(self, event):
        if self.state not in {
            ConnectionState.HELLO,
            ConnectionState.READY,
            ConnectionState.UPLOADING,
        }:
            raise ProtocolViolation("upload is not allowed in this state")
        turn_id = UUID(event["turnId"])
        if self._upload_turn_id is not None and turn_id != self._upload_turn_id:
            raise ProtocolViolation("uploads must belong to one turn")
        if (
            len(self._active_uploads) + len(self._verified_uploads)
            >= MAX_FILES
        ):
            raise ProtocolViolation("too many attachments")
        attachment_id = UUID(event["attachment"]["id"])
        if (
            attachment_id in self._active_uploads
            or attachment_id in self._verified_uploads
        ):
            raise ProtocolViolation("duplicate attachment ID")
        transfer = UploadTransfer.begin(self.temp_root, event["attachment"])
        self._upload_turn_id = turn_id
        self._active_uploads[attachment_id] = transfer
        self.state = ConnectionState.UPLOADING
        await self._send_raw(
            {
                "type": "attachment.upload.accepted",
                "version": PROTOCOL_VERSION,
                "turnId": event["turnId"],
                "attachmentId": str(attachment_id),
            }
        )

    async def _handle_binary(self, raw):
        if self.state is not ConnectionState.UPLOADING:
            raise ProtocolViolation("binary upload is not expected")
        chunk = decode_binary_frame(raw)
        transfer = self._active_uploads.get(chunk.attachment_id)
        if transfer is None:
            raise ProtocolViolation("unknown upload attachment")
        try:
            transfer.append(chunk)
            if not chunk.final:
                return
            verified = transfer.complete()
        except Exception:
            try:
                transfer.abort()
            finally:
                self._active_uploads.pop(chunk.attachment_id, None)
            if not self._active_uploads:
                self.state = (
                    ConnectionState.READY
                    if self._verified_uploads
                    else ConnectionState.HELLO
                )
            await self._send_raw(
                {
                    "type": "attachment.upload.rejected",
                    "version": PROTOCOL_VERSION,
                    "turnId": str(self._upload_turn_id),
                    "attachmentId": str(chunk.attachment_id),
                    "error": {
                        "code": "file.invalid_upload",
                        "message": "The attachment upload could not be verified.",
                        "retryable": False,
                    },
                }
            )
            return
        self._active_uploads.pop(chunk.attachment_id, None)
        self._verified_uploads[chunk.attachment_id] = verified
        self.state = (
            ConnectionState.UPLOADING
            if self._active_uploads
            else ConnectionState.READY
        )
        await self._send_raw(
            {
                "type": "attachment.upload.completed",
                "version": PROTOCOL_VERSION,
                "turnId": str(self._upload_turn_id),
                "attachmentId": str(chunk.attachment_id),
            }
        )

    async def _start_turn(self, event):
        if self.state not in {
            ConnectionState.HELLO,
            ConnectionState.READY,
        }:
            raise ProtocolViolation("turn cannot start in this state")
        if UUID(event["conversationId"]) != self.conversation_id:
            raise ProtocolViolation("turn conversation does not match hello")
        attachment_ids = event["attachmentIds"]
        if len(attachment_ids) > MAX_FILES:
            raise ProtocolViolation("too many attachments")
        requested = [UUID(attachment_id) for attachment_id in attachment_ids]
        if len(set(requested)) != len(requested):
            raise ProtocolViolation("duplicate attachment ID")
        if any(
            attachment_id not in self._verified_uploads
            for attachment_id in requested
        ):
            raise ProtocolViolation("turn references unknown attachment")
        turn_id = UUID(event["turnId"])
        if self._upload_turn_id is not None and turn_id != self._upload_turn_id:
            raise ProtocolViolation("turn does not match uploaded attachments")

        try:
            accepted, record = self.registry.ledger.accept(
                turn_id,
                self.conversation_id,
            )
        except LedgerCapacityError as error:
            await self.websocket.close(
                code=1013,
                message=error.code.encode("ascii"),
            )
            return
        except ValueError as error:
            raise ProtocolViolation(str(error)) from error

        self.turn_id = turn_id
        self._cancel_preturn_task()
        if not accepted:
            self.state = ConnectionState.TERMINAL
            await self._send_turn_event(
                "turn.duplicate",
                {"status": record.status},
                terminal=True,
            )
            await self.websocket.close()
            return

        self.state = ConnectionState.ACCEPTED
        await self.send_event("turn.accepted", {})
        uploads = [
            self._verified_uploads[attachment_id]
            for attachment_id in requested
        ]
        try:
            await self.delegate.start_turn(self, event, uploads)
        except Exception:
            await self.mark_terminal(
                "turn.failed",
                {
                    "error": {
                        "code": "hermes.turn_failed",
                        "message": "Hermes could not start the turn.",
                        "retryable": False,
                    }
                },
            )

    def _require_active_turn(self, event):
        if (
            self.state is not ConnectionState.ACCEPTED
            or self.turn_id is None
            or UUID(event["turnId"]) != self.turn_id
        ):
            raise ProtocolViolation("event does not belong to active turn")

    async def send_event(self, event_type: str, payload: dict) -> None:
        await self._send_turn_event(event_type, payload, terminal=False)

    async def _send_turn_event(
        self,
        event_type,
        payload,
        *,
        terminal,
    ):
        if self.turn_id is None:
            raise ValueError("turn has not been accepted")
        async with self._send_lock:
            required_state = (
                ConnectionState.TERMINAL
                if terminal
                else ConnectionState.ACCEPTED
            )
            if self.state is not required_state:
                raise ValueError("turn no longer accepts this event")
            self._sequence += 1
            event = {
                "type": event_type,
                "version": PROTOCOL_VERSION,
                "turnId": str(self.turn_id),
                "sequence": self._sequence,
                "payload": payload,
            }
            await self.websocket.send_str(encode_event(event))

    async def send_attachment(
        self,
        path: Path,
        metadata: dict,
        *,
        trusted_name=None,
    ) -> None:
        attachment_id = UUID(metadata["id"])
        await self._reserve_outbound_attachment(attachment_id)
        source = validate_outbound_path(path, self.outbound_roots)
        snapshot = None
        frames = None
        original_error = None
        try:
            snapshot = create_outbound_snapshot(
                source,
                self.temp_root,
                cleanup_owner=self._snapshot_cleanup_owner,
                trusted_name=trusted_name,
            )
            attachment = snapshot.metadata(attachment_id)
            frames = iter_download_frames(
                snapshot.source,
                attachment_id,
            )
            async with self._send_lock:
                if self.state is not ConnectionState.ACCEPTED:
                    raise ValueError("turn is not active")
                self._sequence += 1
                begin = {
                    "type": "attachment.download.begin",
                    "version": PROTOCOL_VERSION,
                    "turnId": str(self.turn_id),
                    "sequence": self._sequence,
                    "payload": {"attachment": attachment},
                }
                await self.websocket.send_str(encode_event(begin))
                for frame in frames:
                    await self.websocket.send_bytes(frame)
                self._sequence += 1
                completed = {
                    "type": "attachment.download.completed",
                    "version": PROTOCOL_VERSION,
                    "turnId": str(self.turn_id),
                    "sequence": self._sequence,
                    "payload": {"attachmentId": str(attachment_id)},
                }
                await self.websocket.send_str(encode_event(completed))
        except BaseException as error:
            original_error = error
            raise
        finally:
            if frames is not None:
                frames.close()
            if snapshot is not None:
                self._snapshot_cleanup_owner.close_snapshot(
                    snapshot,
                    suppress=original_error is not None,
                )
            else:
                source.close()

    async def _reserve_outbound_attachment(self, attachment_id):
        """Permanently consume one ID and slot for this turn.

        A reservation is intentionally not rolled back when validation,
        snapshotting, or delivery fails, so concurrent callers observe one
        deterministic identity/cardinality history.
        """
        async with self._outbound_reservation_lock:
            if self.state is not ConnectionState.ACCEPTED:
                raise ValueError("turn is not active")
            if attachment_id in self._outbound_attachment_ids:
                raise ValueError("outbound attachment ID is already reserved")
            if len(self._outbound_attachment_ids) >= MAX_FILES:
                raise ValueError("outbound attachment limit reached")
            self._outbound_attachment_ids.add(attachment_id)

    async def mark_terminal(
        self,
        event_type: str,
        payload: dict,
    ) -> None:
        status_by_event = {
            "turn.completed": "completed",
            "turn.failed": "failed",
            "turn.cancelled": "cancelled",
        }
        if event_type not in status_by_event:
            raise ValueError("invalid terminal event type")
        async with self._terminal_lock:
            if self.state in {
                ConnectionState.TERMINAL,
                ConnectionState.CLOSED,
            }:
                return
            if self.state is not ConnectionState.ACCEPTED:
                raise ValueError("turn is not active")
            self.registry.ledger.mark_terminal(
                self.turn_id,
                status_by_event[event_type],
            )
            self.state = ConnectionState.TERMINAL
        try:
            await self._send_turn_event(
                event_type,
                payload,
                terminal=True,
            )
        finally:
            await self.close()

    async def _cancel_from_client(self):
        async with self._terminal_lock:
            if self.state is not ConnectionState.ACCEPTED:
                return
            if self._cancel_started:
                return
            self._cancel_started = True
            self.state = ConnectionState.TERMINAL
        try:
            try:
                await self.delegate.cancel_turn(self)
            except Exception:
                pass
            self.registry.ledger.mark_terminal(
                self.turn_id,
                "cancelled",
            )
            await self._send_turn_event(
                "turn.cancelled",
                {},
                terminal=True,
            )
        finally:
            await self.close()

    def send_event_threadsafe(
        self,
        event_type: str,
        payload: dict,
    ) -> None:
        if self._loop is None or self._loop.is_closed():
            raise RuntimeError("connection event loop is unavailable")
        future = asyncio.run_coroutine_threadsafe(
            self.send_event(event_type, payload),
            self._loop,
        )

        def consume_failure(completed):
            try:
                completed.result()
            except Exception:
                pass

        future.add_done_callback(consume_failure)

    async def _heartbeat_loop(self):
        loop = asyncio.get_running_loop()
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                now = loop.time()
                if any(
                    deadline <= now
                    for deadline in self._pending_heartbeats.values()
                ):
                    await self.close()
                    return
                nonce = secrets.token_urlsafe(18)
                self._pending_heartbeats[nonce] = (
                    now + self._heartbeat_timeout
                )
                await self._send_raw(
                    {
                        "type": "heartbeat",
                        "version": PROTOCOL_VERSION,
                        "nonce": nonce,
                    }
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.close()

    async def _preturn_deadline(self):
        try:
            await asyncio.sleep(self._preturn_timeout)
            if self.state in {
                ConnectionState.HELLO,
                ConnectionState.UPLOADING,
                ConnectionState.READY,
            }:
                await self.close()
        except asyncio.CancelledError:
            raise

    def _cancel_preturn_task(self):
        task = self._preturn_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()

    async def close(self):
        try:
            if not self.websocket.closed:
                await self.websocket.close()
        finally:
            await self._cleanup()

    async def _cleanup(self):
        async with self._cleanup_lock:
            if self._cleaned:
                self._snapshot_cleanup_owner.retry(suppress=True)
                self._verified_upload_cleanup_owner.retry(
                    suppress=False
                )
                return
            self._cleaned = True
            try:
                current = asyncio.current_task()
                timer_tasks = [
                    task
                    for task in (
                        self._heartbeat_task,
                        self._preturn_task,
                    )
                    if task is not None and task is not current
                ]
                for task in timer_tasks:
                    task.cancel()
                if timer_tasks:
                    await asyncio.gather(
                        *timer_tasks,
                        return_exceptions=True,
                    )

                for transfer in self._active_uploads.values():
                    transfer.abort()
                self._active_uploads.clear()
                for upload in self._verified_uploads.values():
                    self._verified_upload_cleanup_owner.close_upload(
                        upload,
                        suppress=True,
                    )
                self._verified_uploads.clear()

                should_cancel = False
                async with self._terminal_lock:
                    if (
                        self.state is ConnectionState.ACCEPTED
                        and not self._cancel_started
                    ):
                        self._cancel_started = True
                        should_cancel = True
                if should_cancel:
                    try:
                        await self.delegate.cancel_turn(self)
                    except Exception:
                        pass
                    async with self._terminal_lock:
                        if self.state is ConnectionState.ACCEPTED:
                            try:
                                self.registry.ledger.mark_terminal(
                                    self.turn_id,
                                    "cancelled",
                                )
                            except Exception:
                                pass
                            else:
                                self.state = ConnectionState.TERMINAL
            finally:
                try:
                    if self.conversation_id is not None:
                        await self.registry.release(
                            self.conversation_id,
                            self,
                        )
                finally:
                    try:
                        self._snapshot_cleanup_owner.retry(
                            suppress=True
                        )
                        self._verified_upload_cleanup_owner.retry(
                            suppress=False
                        )
                    finally:
                        self.state = ConnectionState.CLOSED
