"""Hermes user-platform adapter for the native BearCode transport."""
import asyncio
import os
from pathlib import Path
from uuid import uuid4

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    cache_media_bytes,
    get_audio_cache_dir,
    get_document_cache_dir,
    get_image_cache_dir,
    get_video_cache_dir,
)
from gateway.session import build_session_key
from tools.approval import resolve_gateway_approval
from tools.clarify_gateway import resolve_gateway_clarify

from bearcode_transport.server import BearCodeServer


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8643


def _extra(config):
    value = getattr(config, "extra", {}) or {}
    return value if isinstance(value, dict) else {}


def _platform_key(config):
    return os.getenv("BEARCODE_PLATFORM_KEY") or _extra(config).get(
        "platform_key",
        "",
    )


def _listen_host(config):
    value = os.getenv("BEARCODE_LISTEN_HOST") or _extra(config).get(
        "listen_host",
        DEFAULT_HOST,
    )
    return str(value).strip() or DEFAULT_HOST


def _raw_port(config):
    environment = os.getenv("BEARCODE_LISTEN_PORT")
    if environment is not None:
        return environment
    return _extra(config).get("listen_port", DEFAULT_PORT)


def _valid_port(value):
    if isinstance(value, bool):
        return False
    try:
        port = int(value)
    except (TypeError, ValueError):
        return False
    return 1 <= port <= 65535


def _listen_port(config):
    value = _raw_port(config)
    return int(value) if _valid_port(value) else DEFAULT_PORT


def check_requirements():
    """Return whether the runtime dependency is importable."""
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config):
    key = _platform_key(config)
    return (
        isinstance(key, str)
        and bool(key.strip())
        and _valid_port(_raw_port(config))
    )


def is_connected(config):
    return validate_config(config)


def _env_enablement():
    key = os.getenv("BEARCODE_PLATFORM_KEY", "")
    if not key.strip():
        return None
    seed = {
        "listen_host": (
            os.getenv("BEARCODE_LISTEN_HOST", "").strip() or DEFAULT_HOST
        )
    }
    raw_port = os.getenv("BEARCODE_LISTEN_PORT", "")
    seed["listen_port"] = (
        int(raw_port) if _valid_port(raw_port) else DEFAULT_PORT
    )
    return seed


class BearCodeAdapter(BasePlatformAdapter):
    """Bridge authenticated BearCode turns into Hermes message events."""

    supports_status_text = True
    REQUIRES_EDIT_FINALIZE = True

    def __init__(self, config, *, server_factory=BearCodeServer):
        super().__init__(
            config=config,
            platform=Platform("bearcode"),
        )
        image_root = Path(get_image_cache_dir())
        audio_root = Path(get_audio_cache_dir())
        video_root = Path(get_video_cache_dir())
        document_root = Path(get_document_cache_dir())
        self._outbound_roots = (
            image_root,
            audio_root,
            video_root,
            document_root,
        )
        temp_root = document_root / ".bearcode-transfers"
        state_root = document_root.parent / ".bearcode-state"
        self._server = server_factory(
            host=_listen_host(config),
            port=_listen_port(config),
            platform_key=_platform_key(config),
            delegate=self,
            temp_root=temp_root,
            state_root=state_root,
            outbound_roots=self._outbound_roots,
        )
        self._loop = None
        self._pending_connections = {}
        self._connections_by_chat = {}
        self._sources_by_connection = {}
        self._messages = {}
        self._message_connections = {}
        self._finalized_messages = set()
        self._status_tools = {}
        self._approval_requests = {}
        self._clarification_requests = {}
        self._terminating_connections = set()

    @property
    def name(self):
        return "BearCode"

    async def connect(self, *, is_reconnect=False):
        del is_reconnect
        if not validate_config(self.config):
            return False
        self._loop = asyncio.get_running_loop()
        try:
            await self._server.start()
        except Exception:
            self._loop = None
            self._running = False
            return False
        self._mark_connected()
        return True

    async def disconnect(self):
        try:
            await self._server.stop()
        finally:
            self._mark_disconnected()
            self._loop = None
            self._pending_connections.clear()
            self._connections_by_chat.clear()
            self._sources_by_connection.clear()
            self._status_tools.clear()
            self._approval_requests.clear()
            self._clarification_requests.clear()

    async def start_turn(self, connection, event, uploads):
        conversation_id = str(event["conversationId"])
        installation_id = str(connection.installation_id)
        turn_id = str(event["turnId"])
        media_urls = []
        media_types = []
        only_images = bool(uploads)
        try:
            for upload in uploads:
                data = upload.path.read_bytes()
                kind = (
                    "image"
                    if upload.mime.startswith("image/")
                    else "document"
                )
                cached = cache_media_bytes(
                    data,
                    filename=upload.name,
                    mime_type=upload.mime,
                    default_kind=kind,
                )
                if cached is None:
                    raise ValueError(
                        "Hermes rejected the verified media bytes"
                    )
                media_urls.append(cached.path)
                media_types.append(cached.media_type)
                only_images = only_images and cached.kind == "image"
        finally:
            for upload in uploads:
                try:
                    upload.path.unlink(missing_ok=True)
                except OSError:
                    pass

        source = self.build_source(
            chat_id=conversation_id,
            chat_name="BearCode",
            chat_type="dm",
            user_id=installation_id,
            user_name="BearCode user",
            message_id=turn_id,
            role_authorized=True,
        )
        message_type = (
            MessageType.PHOTO
            if only_images
            else MessageType.DOCUMENT
            if media_urls
            else MessageType.TEXT
        )
        message_event = MessageEvent(
            text=event["text"],
            message_type=message_type,
            source=source,
            message_id=turn_id,
            media_urls=media_urls,
            media_types=media_types,
            metadata={"bearcode_turn_id": turn_id},
        )
        self._pending_connections[id(message_event)] = connection
        self._sources_by_connection[connection] = source
        await self.handle_message(message_event)

    def _session_key(self, source):
        extra = _extra(self.config)
        return build_session_key(
            source,
            group_sessions_per_user=extra.get(
                "group_sessions_per_user",
                True,
            ),
            thread_sessions_per_user=extra.get(
                "thread_sessions_per_user",
                False,
            ),
        )

    async def cancel_turn(self, connection):
        source = self._sources_by_connection.get(connection)
        if source is None:
            return
        await self.cancel_session_processing(
            self._session_key(source),
            release_guard=True,
            discard_pending=True,
        )

    def _connection_is_live(self, connection):
        return any(
            candidate is connection
            for candidate in self._connections_by_chat.values()
        )

    async def resolve_approval(self, connection, request_id, decision):
        owned = self._approval_requests.get(str(request_id))
        if (
            owned is None
            or owned[0] is not connection
            or not self._connection_is_live(connection)
        ):
            return False
        self._approval_requests.pop(str(request_id), None)
        return bool(resolve_gateway_approval(owned[1], decision))

    async def resolve_clarification(
        self,
        connection,
        request_id,
        response,
    ):
        owned = self._clarification_requests.get(str(request_id))
        if (
            owned is not connection
            or not self._connection_is_live(connection)
        ):
            return False
        self._clarification_requests.pop(str(request_id), None)
        return bool(resolve_gateway_clarify(str(request_id), response))

    def _connection_for_chat(self, chat_id):
        return self._connections_by_chat.get(str(chat_id))

    async def send(
        self,
        chat_id,
        content,
        reply_to=None,
        metadata=None,
    ):
        del reply_to, metadata
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return SendResult(
                success=False,
                error="BearCode turn is not active",
            )
        message_id = str(uuid4())
        text = str(content)
        try:
            await connection.send_event(
                "assistant.started",
                {"messageId": message_id},
            )
            await connection.send_event(
                "assistant.delta",
                {"messageId": message_id, "text": text},
            )
        except Exception:
            return SendResult(
                success=False,
                error="BearCode message delivery failed",
            )
        self._messages[message_id] = text
        self._message_connections[message_id] = connection
        return SendResult(success=True, message_id=message_id)

    async def edit_message(
        self,
        chat_id,
        message_id,
        content,
        *,
        finalize=False,
    ):
        connection = self._connection_for_chat(chat_id)
        if (
            connection is None
            or self._message_connections.get(str(message_id))
            is not connection
            or str(message_id) not in self._messages
        ):
            return SendResult(
                success=False,
                error="BearCode message is not active",
            )
        message_id = str(message_id)
        previous = self._messages[message_id]
        current = str(content)
        try:
            if current.startswith(previous):
                suffix = current[len(previous):]
                if suffix:
                    await connection.send_event(
                        "assistant.delta",
                        {"messageId": message_id, "text": suffix},
                    )
            else:
                await connection.send_event(
                    "assistant.delta",
                    {
                        "messageId": message_id,
                        "text": current,
                        "replace": True,
                    },
                )
            self._messages[message_id] = current
            if finalize and message_id not in self._finalized_messages:
                await connection.send_event(
                    "assistant.completed",
                    {"messageId": message_id},
                )
                self._finalized_messages.add(message_id)
        except Exception:
            return SendResult(
                success=False,
                message_id=message_id,
                error="BearCode message edit failed",
            )
        return SendResult(success=True, message_id=message_id)

    async def _send_attachment(self, chat_id, path):
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return SendResult(
                success=False,
                error="BearCode turn is not active",
            )
        safe_path = self.validate_media_delivery_path(str(path))
        if safe_path is None:
            return SendResult(
                success=False,
                error="Attachment path is not approved for delivery",
            )
        attachment_id = str(uuid4())
        try:
            await connection.send_attachment(
                Path(safe_path),
                {"id": attachment_id},
            )
        except Exception:
            return SendResult(
                success=False,
                error="BearCode attachment delivery failed",
            )
        return SendResult(success=True, message_id=attachment_id)

    async def send_document(
        self,
        chat_id,
        file_path,
        caption=None,
        file_name=None,
        reply_to=None,
        metadata=None,
        **kwargs,
    ):
        del caption, file_name, reply_to, metadata, kwargs
        return await self._send_attachment(chat_id, file_path)

    async def send_image_file(
        self,
        chat_id,
        image_path,
        caption=None,
        reply_to=None,
        metadata=None,
        **kwargs,
    ):
        del caption, reply_to, metadata, kwargs
        return await self._send_attachment(chat_id, image_path)

    async def send_exec_approval(
        self,
        chat_id,
        command,
        session_key,
        description="dangerous command",
        metadata=None,
        allow_permanent=True,
        allow_session=True,
        smart_denied=False,
    ):
        del metadata
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return SendResult(
                success=False,
                error="BearCode turn is not active",
            )
        request_id = str(uuid4())
        status = self._status_tools.get(str(chat_id))
        tool_call_id = (
            status["id"] if status is not None else str(uuid4())
        )
        try:
            await connection.send_event(
                "approval.requested",
                {
                    "requestId": request_id,
                    "toolCallId": tool_call_id,
                    "command": str(command),
                    "description": str(description),
                    "allowSession": bool(allow_session),
                    "allowPermanent": bool(allow_permanent),
                    "smartDenied": bool(smart_denied),
                },
            )
        except Exception:
            return SendResult(
                success=False,
                error="BearCode approval delivery failed",
            )
        self._approval_requests[request_id] = (
            connection,
            str(session_key),
        )
        return SendResult(success=True, message_id=request_id)

    async def send_clarify(
        self,
        chat_id,
        question,
        choices,
        clarify_id,
        session_key,
        metadata=None,
    ):
        del session_key, metadata
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return SendResult(
                success=False,
                error="BearCode turn is not active",
            )
        request_id = str(clarify_id)
        normalized_choices = (
            list(choices) if choices is not None else None
        )
        try:
            await connection.send_event(
                "clarification.requested",
                {
                    "requestId": request_id,
                    "question": str(question),
                    "choices": normalized_choices,
                },
            )
        except Exception:
            return SendResult(
                success=False,
                error="BearCode clarification delivery failed",
            )
        self._clarification_requests[request_id] = connection
        return SendResult(success=True, message_id=request_id)

    def set_status_text(self, chat_id, text):
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(
            self._schedule_status_update,
            str(chat_id),
            text,
        )

    def _schedule_status_update(self, chat_id, text):
        task = self._loop.create_task(
            self._apply_status_update(chat_id, text)
        )

        def consume_failure(completed):
            try:
                completed.result()
            except Exception:
                pass

        task.add_done_callback(consume_failure)

    async def _apply_status_update(self, chat_id, text):
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return
        status = self._status_tools.get(chat_id)
        if text:
            label = str(text)
            if status is None:
                tool_call_id = str(uuid4())
                self._status_tools[chat_id] = {
                    "id": tool_call_id,
                    "label": label,
                }
                await connection.send_event(
                    "tool.started",
                    {
                        "toolCallId": tool_call_id,
                        "name": "_status",
                        "label": label,
                    },
                )
            elif status["label"] != label:
                status["label"] = label
                await connection.send_event(
                    "tool.progress",
                    {
                        "toolCallId": status["id"],
                        "label": label,
                    },
                )
            return
        if status is not None:
            self._status_tools.pop(chat_id, None)
            await connection.send_event(
                "tool.completed",
                {
                    "toolCallId": status["id"],
                    "status": "completed",
                },
            )

    async def on_processing_start(self, event):
        connection = self._pending_connections.pop(id(event), None)
        if connection is None:
            return
        self._connections_by_chat[str(event.source.chat_id)] = connection
        self._sources_by_connection[connection] = event.source

    async def on_processing_complete(self, event, outcome):
        connection = self._connections_by_chat.get(
            str(event.source.chat_id)
        )
        if (
            connection is None
            or connection in self._terminating_connections
        ):
            return
        self._terminating_connections.add(connection)
        if outcome is ProcessingOutcome.SUCCESS:
            event_type = "turn.completed"
            payload = {"sessionId": self._session_key(event.source)}
        elif outcome is ProcessingOutcome.CANCELLED:
            event_type = "turn.cancelled"
            payload = {}
        else:
            event_type = "turn.failed"
            payload = {
                "error": {
                    "code": "hermes.turn_failed",
                    "message": "Hermes could not complete the turn.",
                    "retryable": False,
                }
            }
        try:
            await connection.mark_terminal(event_type, payload)
        finally:
            self._cleanup_connection(connection)
            self._terminating_connections.discard(connection)

    def _cleanup_connection(self, connection):
        for chat_id, candidate in tuple(
            self._connections_by_chat.items()
        ):
            if candidate is connection:
                self._connections_by_chat.pop(chat_id, None)
                self._status_tools.pop(chat_id, None)
        self._sources_by_connection.pop(connection, None)
        for request_id, owned in tuple(self._approval_requests.items()):
            if owned[0] is connection:
                self._approval_requests.pop(request_id, None)
        for request_id, owned in tuple(
            self._clarification_requests.items()
        ):
            if owned is connection:
                self._clarification_requests.pop(request_id, None)
        for message_id, owned in tuple(
            self._message_connections.items()
        ):
            if owned is connection:
                self._message_connections.pop(message_id, None)
                self._messages.pop(message_id, None)
                self._finalized_messages.discard(message_id)

    async def get_chat_info(self, chat_id):
        return {
            "id": str(chat_id),
            "name": "BearCode",
            "type": "dm",
        }


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
