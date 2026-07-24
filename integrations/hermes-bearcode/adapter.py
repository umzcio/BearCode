"""Hermes user-platform adapter for the native BearCode transport."""
import asyncio
from contextlib import contextmanager
import errno
import hashlib
import os
from pathlib import Path
import stat
import threading
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

from bearcode_transport.protocol import MAX_CHUNK_BYTES, MAX_FILE_BYTES
from bearcode_transport.server import BearCodeServer


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8643


def _same_file(left, right):
    return (
        stat.S_ISREG(left.st_mode)
        and stat.S_ISREG(right.st_mode)
        and left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
    )


def _open_regular_nofollow(path):
    """Open an absolute regular file without following any path symlink."""
    path = Path(path)
    if not path.is_absolute() or path.name in {"", ".", ".."}:
        raise ValueError("attachment path is not an absolute file path")
    directory_flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )
    file_flags = (
        os.O_RDONLY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )
    directory_fd = os.open(path.anchor, directory_flags)
    try:
        for component in path.parts[1:-1]:
            next_fd = os.open(
                component,
                directory_flags,
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(path.name, file_flags, dir_fd=directory_fd)
    finally:
        os.close(directory_fd)
    file_info = os.fstat(file_fd)
    if not stat.S_ISREG(file_info.st_mode):
        os.close(file_fd)
        raise ValueError("attachment source is not a regular file")
    return file_fd, file_info


def _open_parent_nofollow(path):
    path = Path(path)
    flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )
    descriptor = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:-1]:
            next_descriptor = os.open(
                component,
                flags,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class _OwnedStagedFile:
    def __init__(self, descriptor, parent_descriptor, name, file_info):
        self.descriptor = descriptor
        self.parent_descriptor = parent_descriptor
        self.name = name
        self.identity = (
            (file_info.st_dev, file_info.st_ino)
            if hasattr(file_info, "st_dev")
            else file_info
        )
        self.scrubbed = False
        self.unlinked = False

    def cleanup(self):
        if not self.scrubbed:
            os.ftruncate(self.descriptor, 0)
            os.fsync(self.descriptor)
            self.scrubbed = True
        if not self.unlinked:
            try:
                named = os.stat(
                    self.name,
                    dir_fd=self.parent_descriptor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                named = None
            if named is not None:
                if (named.st_dev, named.st_ino) != self.identity:
                    named = None
                else:
                    os.unlink(self.name, dir_fd=self.parent_descriptor)
            self.unlinked = True
        for attribute in ("descriptor", "parent_descriptor"):
            descriptor = getattr(self, attribute)
            if descriptor is None:
                continue
            setattr(self, attribute, None)
            try:
                os.close(descriptor)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise


class _StagedCleanupError(RuntimeError):
    pass


class _StagedCleanupOwner:
    def __init__(self):
        self._pending = {}

    def close(self, owned):
        try:
            owned.cleanup()
        except (OSError, ValueError):
            self._pending[id(owned)] = owned
            return False
        self._pending.pop(id(owned), None)
        return True

    def retry(self):
        for owned in tuple(self._pending.values()):
            self.close(owned)
        if self._pending:
            raise _StagedCleanupError(
                "BearCode staged file cleanup remains pending"
            )


def _write_all(descriptor, data):
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            raise OSError("attachment staging write did not progress")
        offset += written


def _read_verified_upload(upload, cleanup_owner):
    descriptor = None
    owned = None
    try:
        (
            descriptor,
            parent_descriptor,
            active_name,
            expected_identity,
        ) = upload.take_ownership()
        owned = _OwnedStagedFile(
            descriptor,
            parent_descriptor,
            active_name,
            expected_identity,
        )
        descriptor = None
        initial = os.fstat(owned.descriptor)
        if (
            not stat.S_ISREG(initial.st_mode)
            or (initial.st_dev, initial.st_ino) != expected_identity
        ):
            raise ValueError("verified upload descriptor changed")
        if (
            not isinstance(upload.size_bytes, int)
            or isinstance(upload.size_bytes, bool)
            or not 0 <= upload.size_bytes <= MAX_FILE_BYTES
            or initial.st_size != upload.size_bytes
        ):
            raise ValueError("verified upload size is invalid")
        digest = hashlib.sha256()
        data = bytearray()
        os.lseek(owned.descriptor, 0, os.SEEK_SET)
        while True:
            chunk = os.read(owned.descriptor, MAX_CHUNK_BYTES)
            if not chunk:
                break
            data.extend(chunk)
            digest.update(chunk)
            if len(data) > upload.size_bytes:
                raise ValueError("verified upload changed while reading")
        final = os.fstat(owned.descriptor)
        try:
            named = os.stat(
                owned.name,
                dir_fd=owned.parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            named = None
        if (
            len(data) != upload.size_bytes
            or digest.hexdigest() != upload.sha256
            or not _same_file(initial, final)
            or final.st_size != upload.size_bytes
        ):
            raise ValueError("verified upload integrity check failed")
        if named is not None and not _same_file(initial, named):
            named = None
        return bytes(data), owned
    except BaseException:
        if owned is not None:
            cleanup_owner.close(owned)
        raise
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


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
    supports_async_delivery = False
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
        directory_flags = (
            os.O_RDONLY
            | os.O_DIRECTORY
            | os.O_NOFOLLOW
            | getattr(os, "O_CLOEXEC", 0)
        )
        document_fd = os.open(document_root, directory_flags)
        staging_fd = None
        try:
            try:
                os.mkdir(temp_root.name, 0o700, dir_fd=document_fd)
            except FileExistsError:
                pass
            staging_fd = os.open(
                temp_root.name,
                directory_flags,
                dir_fd=document_fd,
            )
            temp_info = os.fstat(staging_fd)
            if not stat.S_ISDIR(temp_info.st_mode):
                raise RuntimeError(
                    "BearCode transfer staging root is unsafe"
                )
            os.fchmod(staging_fd, 0o700)
        finally:
            if staging_fd is not None:
                os.close(staging_fd)
            os.close(document_fd)
        self._staging_root = temp_root
        self._staging_identity = temp_info
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
        self._status_epoch = 0
        self._status_tasks = set()
        self._status_producers = {}
        self._status_producers_lock = threading.Lock()
        self._cleanup_owner = _StagedCleanupOwner()
        self._pending_connections = {}
        self._connections_by_chat = {}
        self._connections_by_event = {}
        self._turns_by_chat = {}
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
        self._status_epoch += 1
        try:
            await self._server.start()
        except Exception:
            self._status_epoch += 1
            self._loop = None
            self._running = False
            return False
        self._mark_connected()
        return True

    async def disconnect(self):
        self._status_epoch += 1
        self._loop = None
        status_tasks = tuple(self._status_tasks)
        for task in status_tasks:
            task.cancel()
        try:
            if status_tasks:
                await asyncio.gather(
                    *status_tasks,
                    return_exceptions=True,
                )
            await self._server.stop()
        finally:
            self._mark_disconnected()
            self._status_tasks.clear()
            with self._status_producers_lock:
                self._status_producers.clear()
                self._turns_by_chat.clear()
            self._pending_connections.clear()
            self._connections_by_chat.clear()
            self._connections_by_event.clear()
            self._sources_by_connection.clear()
            self._messages.clear()
            self._message_connections.clear()
            self._finalized_messages.clear()
            self._status_tools.clear()
            self._approval_requests.clear()
            self._clarification_requests.clear()
            self._terminating_connections.clear()
            self._cleanup_owner.retry()

    async def start_turn(self, connection, event, uploads):
        conversation_id = str(event["conversationId"])
        installation_id = str(connection.installation_id)
        turn_id = str(event["turnId"])
        media_urls = []
        media_types = []
        only_images = bool(uploads)
        owned_uploads = []
        try:
            for upload in uploads:
                data, owned = _read_verified_upload(
                    upload,
                    self._cleanup_owner,
                )
                owned_uploads.append(owned)
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
            for owned in owned_uploads:
                self._cleanup_owner.close(owned)

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
        event_id = id(message_event)
        owned_event = (
            message_event,
            connection,
        )
        self._pending_connections[event_id] = owned_event
        self._sources_by_connection[connection] = source
        try:
            await self.handle_message(message_event)
        except BaseException:
            if self._pending_connections.get(event_id) is owned_event:
                self._pending_connections.pop(event_id, None)
            active = self._connections_by_event.get(event_id)
            if (
                active is not None
                and active[0] is message_event
                and active[1] is connection
            ):
                self._connections_by_event.pop(event_id, None)
                chat_id = str(message_event.source.chat_id)
                with self._status_producers_lock:
                    binding = self._turns_by_chat.get(chat_id)
                    if (
                        binding is not None
                        and binding[0] is message_event
                        and binding[1] is connection
                    ):
                        self._turns_by_chat.pop(chat_id, None)
                        for producer, produced in tuple(
                            self._status_producers.items()
                        ):
                            if produced[1] is binding:
                                self._status_producers.pop(
                                    producer,
                                    None,
                                )
                    else:
                        binding = None
                if binding is not None:
                    self._connections_by_chat.pop(chat_id, None)
                    self._status_tools.pop(chat_id, None)
            if (
                self._sources_by_connection.get(connection) is source
                and not any(
                    active[1] is connection
                    for active in self._connections_by_event.values()
                )
            ):
                self._sources_by_connection.pop(connection, None)
            raise

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
            owned is None
            or owned[0] is not connection
            or not self._connection_is_live(connection)
        ):
            return False
        self._clarification_requests.pop(str(request_id), None)
        return bool(resolve_gateway_clarify(str(request_id), response))

    def _connection_for_chat(self, chat_id):
        return self._connections_by_chat.get(str(chat_id))

    def _turn_binding(self, chat_id):
        with self._status_producers_lock:
            return self._turns_by_chat.get(str(chat_id))

    def _turn_binding_is_current(self, chat_id, binding):
        with self._status_producers_lock:
            return self._turns_by_chat.get(str(chat_id)) is binding

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

    def _is_direct_cache_path(self, path):
        for root in self._outbound_roots:
            try:
                path.relative_to(root.resolve(strict=True))
            except (OSError, ValueError):
                continue
            return True
        return False

    @contextmanager
    def _stage_external_attachment(
        self,
        source_path,
        expected_source,
    ):
        source_fd = None
        staging_fd = None
        destination_fd = None
        partial_name = None
        completed_name = None
        owned_partial = None
        owned_completed = None
        try:
            source_fd, initial_source = _open_regular_nofollow(
                source_path
            )
            if not _same_file(expected_source, initial_source):
                raise ValueError("attachment source changed during validation")
            if initial_source.st_size > MAX_FILE_BYTES:
                raise ValueError("attachment exceeds the delivery size limit")

            staging_fd = os.open(
                self._staging_root,
                os.O_RDONLY
                | os.O_DIRECTORY
                | os.O_NOFOLLOW
                | getattr(os, "O_CLOEXEC", 0),
            )
            staging_info = os.fstat(staging_fd)
            if (
                not stat.S_ISDIR(staging_info.st_mode)
                or staging_info.st_dev != self._staging_identity.st_dev
                or staging_info.st_ino != self._staging_identity.st_ino
            ):
                raise ValueError("attachment staging root changed")
            token = uuid4().hex
            partial_name = f".{token}.partial"
            completed_name = f"{token}.attachment"
            destination_fd = os.open(
                partial_name,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | os.O_NOFOLLOW
                | getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=staging_fd,
            )
            partial_info = os.fstat(destination_fd)
            owned_partial = _OwnedStagedFile(
                os.dup(destination_fd),
                os.dup(staging_fd),
                partial_name,
                partial_info,
            )
            os.fchmod(destination_fd, 0o600)

            copied = 0
            copied_digest = hashlib.sha256()
            while True:
                remaining_with_overflow_byte = (
                    MAX_FILE_BYTES - copied + 1
                )
                chunk = os.read(
                    source_fd,
                    min(MAX_CHUNK_BYTES, remaining_with_overflow_byte),
                )
                if not chunk:
                    break
                copied += len(chunk)
                if copied > MAX_FILE_BYTES:
                    raise ValueError(
                        "attachment exceeds the delivery size limit"
                    )
                _write_all(destination_fd, chunk)
                copied_digest.update(chunk)

            final_source = os.fstat(source_fd)
            if (
                not _same_file(initial_source, final_source)
                or final_source.st_size != copied
                or final_source.st_mtime_ns
                != initial_source.st_mtime_ns
            ):
                raise ValueError("attachment source changed during staging")

            os.lseek(source_fd, 0, os.SEEK_SET)
            verified = 0
            verified_digest = hashlib.sha256()
            while True:
                remaining_with_overflow_byte = (
                    MAX_FILE_BYTES - verified + 1
                )
                chunk = os.read(
                    source_fd,
                    min(MAX_CHUNK_BYTES, remaining_with_overflow_byte),
                )
                if not chunk:
                    break
                verified += len(chunk)
                if verified > MAX_FILE_BYTES:
                    raise ValueError(
                        "attachment exceeds the delivery size limit"
                    )
                verified_digest.update(chunk)

            verified_source = os.fstat(source_fd)
            named_source = os.stat(source_path, follow_symlinks=False)
            if (
                verified != copied
                or not _same_file(initial_source, verified_source)
                or not _same_file(initial_source, named_source)
                or verified_source.st_size != verified
                or verified_source.st_mtime_ns
                != initial_source.st_mtime_ns
                or copied_digest.digest()
                != verified_digest.digest()
            ):
                raise ValueError(
                    "attachment source did not produce a stable snapshot"
                )

            os.fsync(destination_fd)
            os.close(destination_fd)
            destination_fd = None
            os.rename(
                partial_name,
                completed_name,
                src_dir_fd=staging_fd,
                dst_dir_fd=staging_fd,
            )
            partial_name = None
            owned_partial.name = completed_name
            owned_completed = owned_partial
            owned_partial = None
            yield self._staging_root / completed_name
        finally:
            if destination_fd is not None:
                try:
                    os.close(destination_fd)
                except OSError:
                    pass
            if source_fd is not None:
                try:
                    os.close(source_fd)
                except OSError:
                    pass
            if staging_fd is not None:
                if owned_partial is not None:
                    self._cleanup_owner.close(owned_partial)
                    partial_name = None
                if owned_completed is not None:
                    self._cleanup_owner.close(owned_completed)
                    completed_name = None
                for name in (partial_name, completed_name):
                    if name is None:
                        continue
                    try:
                        os.unlink(name, dir_fd=staging_fd)
                    except FileNotFoundError:
                        pass
                    except OSError:
                        pass
                try:
                    os.close(staging_fd)
                except OSError:
                    pass

    async def _send_attachment(self, chat_id, path):
        connection = self._connection_for_chat(chat_id)
        if connection is None:
            return SendResult(
                success=False,
                error="BearCode turn is not active",
            )
        try:
            expected_source = os.stat(path)
        except (OSError, TypeError, ValueError):
            expected_source = None
        safe_path = self.validate_media_delivery_path(str(path))
        if safe_path is None:
            return SendResult(
                success=False,
                error="Attachment path is not approved for delivery",
            )
        attachment_id = str(uuid4())
        try:
            safe_path = Path(safe_path)
            if self._is_direct_cache_path(safe_path):
                await connection.send_attachment(
                    safe_path,
                    {"id": attachment_id},
                )
            else:
                if expected_source is None:
                    raise ValueError(
                        "attachment source could not be inspected"
                    )
                with self._stage_external_attachment(
                    safe_path,
                    expected_source,
                ) as staged_path:
                    await connection.send_attachment(
                        staged_path,
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
        binding = self._turn_binding(chat_id)
        if status is not None and status.get("binding") is not binding:
            status = None
        tool_call_id = (
            status["id"] if status is not None else str(uuid4())
        )
        owned = (connection, str(session_key))
        self._approval_requests[request_id] = owned
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
            if self._approval_requests.get(request_id) is owned:
                self._approval_requests.pop(request_id, None)
            return SendResult(
                success=False,
                error="BearCode approval delivery failed",
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
        owned = (connection, object())
        self._clarification_requests[request_id] = owned
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
            if self._clarification_requests.get(request_id) is owned:
                self._clarification_requests.pop(request_id, None)
            return SendResult(
                success=False,
                error="BearCode clarification delivery failed",
            )
        return SendResult(success=True, message_id=request_id)

    def set_status_text(self, chat_id, text):
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        epoch = self._status_epoch
        chat_id = str(chat_id)
        producer = threading.get_ident()
        with self._status_producers_lock:
            if text:
                binding = self._turns_by_chat.get(chat_id)
                if binding is None:
                    return
                self._status_producers[producer] = (chat_id, binding)
                if self._turns_by_chat.get(chat_id) is not binding:
                    self._status_producers.pop(producer, None)
                    return
            else:
                produced = self._status_producers.pop(producer, None)
                if produced is None or produced[0] != chat_id:
                    return
                binding = produced[1]
        try:
            loop.call_soon_threadsafe(
                self._schedule_status_update,
                loop,
                epoch,
                chat_id,
                text,
                binding,
            )
        except RuntimeError:
            pass

    def _schedule_status_update(
        self,
        loop,
        epoch,
        chat_id,
        text,
        binding,
    ):
        if (
            loop is not self._loop
            or epoch != self._status_epoch
            or loop.is_closed()
        ):
            return
        task = loop.create_task(
            self._apply_status_update(chat_id, text, binding)
        )
        self._status_tasks.add(task)

        def consume_failure(completed):
            self._status_tasks.discard(completed)
            try:
                completed.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        task.add_done_callback(consume_failure)

    async def _apply_status_update(self, chat_id, text, binding):
        if not self._turn_binding_is_current(chat_id, binding):
            return
        connection = binding[1]
        status = self._status_tools.get(chat_id)
        if status is not None and status.get("binding") is not binding:
            status = None
        if text:
            label = str(text)
            if status is None:
                tool_call_id = str(uuid4())
                self._status_tools[chat_id] = {
                    "id": tool_call_id,
                    "label": label,
                    "binding": binding,
                }
                await connection.send_event(
                    "tool.started",
                    {
                        "toolCallId": tool_call_id,
                        "name": "_status",
                        "label": label,
                    },
                )
                if not self._turn_binding_is_current(chat_id, binding):
                    current = self._status_tools.get(chat_id)
                    if current is not None and current.get(
                        "binding"
                    ) is binding:
                        self._status_tools.pop(chat_id, None)
            elif status["label"] != label:
                if not self._turn_binding_is_current(chat_id, binding):
                    return
                status["label"] = label
                await connection.send_event(
                    "tool.progress",
                    {
                        "toolCallId": status["id"],
                        "label": label,
                    },
                )
                if not self._turn_binding_is_current(chat_id, binding):
                    current = self._status_tools.get(chat_id)
                    if current is status:
                        self._status_tools.pop(chat_id, None)
            return
        if status is not None:
            if not self._turn_binding_is_current(chat_id, binding):
                return
            self._status_tools.pop(chat_id, None)
            await connection.send_event(
                "tool.completed",
                {
                    "toolCallId": status["id"],
                    "status": "completed",
                },
            )

    async def on_processing_start(self, event):
        owned = self._pending_connections.pop(id(event), None)
        if owned is None or owned[0] is not event:
            return
        connection = owned[1]
        self._connections_by_event[id(event)] = (event, connection)
        chat_id = str(event.source.chat_id)
        binding = (event, connection)
        self._status_tools.pop(chat_id, None)
        self._connections_by_chat[chat_id] = connection
        with self._status_producers_lock:
            self._turns_by_chat[chat_id] = binding
        self._sources_by_connection[connection] = event.source

    async def on_processing_complete(self, event, outcome):
        owned = self._connections_by_event.get(id(event))
        connection = (
            owned[1]
            if owned is not None and owned[0] is event
            else None
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
        with self._status_producers_lock:
            for producer, produced in tuple(
                self._status_producers.items()
            ):
                if produced[1][1] is connection:
                    self._status_producers.pop(producer, None)
            for chat_id, binding in tuple(
                self._turns_by_chat.items()
            ):
                if binding[1] is connection:
                    self._turns_by_chat.pop(chat_id, None)
        for event_id, owned in tuple(
            self._pending_connections.items()
        ):
            if owned[1] is connection:
                self._pending_connections.pop(event_id, None)
        for event_id, owned in tuple(
            self._connections_by_event.items()
        ):
            if owned[1] is connection:
                self._connections_by_event.pop(event_id, None)
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
            if owned[0] is connection:
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
