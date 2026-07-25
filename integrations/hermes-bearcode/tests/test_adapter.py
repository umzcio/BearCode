import asyncio
import errno
import hashlib
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import UUID

import adapter as adapter_module
import gateway.platforms.base as hermes_base
from gateway.platforms.base import MessageType, ProcessingOutcome
from tools import approval, clarify_gateway

from adapter import (
    BearCodeAdapter,
    _env_enablement,
    check_requirements,
    is_connected,
    register,
    validate_config,
)
from bearcode_transport.transfers import VerifiedUpload


CONVERSATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
TURN_ID = "44444444-4444-4444-8444-444444444444"
SECOND_TURN_ID = "88888888-8888-4888-8888-888888888888"
SESSION_KEY = f"agent:main:bearcode:dm:{CONVERSATION_ID}"


def owned_upload(**kwargs):
    path = Path(kwargs["path"])
    root_descriptor = os.open(
        path.parent,
        os.O_RDONLY | os.O_DIRECTORY,
    )
    descriptor = os.open(
        path.name,
        os.O_RDWR | os.O_NOFOLLOW,
        dir_fd=root_descriptor,
    )
    file_info = os.fstat(descriptor)
    return VerifiedUpload(
        **kwargs,
        _descriptor=descriptor,
        _root_descriptor=root_descriptor,
        _active_name=path.name,
        _file_identity=(file_info.st_dev, file_info.st_ino),
    )


class FakeServer:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = 0
        self.stopped = 0

    async def start(self):
        self.started += 1

    async def stop(self):
        self.stopped += 1


class FakeConnection:
    def __init__(self):
        self.conversation_id = UUID(CONVERSATION_ID)
        self.installation_id = UUID(INSTALLATION_ID)
        self.turn_id = UUID(TURN_ID)
        self.events = []
        self.attachments = []
        self.attachment_bytes = []
        self.attachment_modes = []
        self.attachment_names = []
        self.terminals = []
        self.closed = False

    async def send_event(self, event_type, payload):
        self.events.append((event_type, payload))

    async def send_attachment(self, path, metadata, *, trusted_name=None):
        path = Path(path)
        self.attachments.append((path, dict(metadata)))
        self.attachment_bytes.append(path.read_bytes())
        self.attachment_modes.append(stat.S_IMODE(path.stat().st_mode))
        self.attachment_names.append(trusted_name)

    async def mark_terminal(self, event_type, payload):
        self.terminals.append((event_type, payload))
        await self.close()

    async def close(self):
        self.closed = True


class FailingAttachmentConnection(FakeConnection):
    async def send_attachment(self, path, metadata, *, trusted_name=None):
        await super().send_attachment(
            path,
            metadata,
            trusted_name=trusted_name,
        )
        raise ConnectionError("simulated delivery failure")


class BlockingAttachmentConnection(FakeConnection):
    def __init__(self):
        super().__init__()
        self.attachment_started = asyncio.Event()
        self.release_attachment = asyncio.Event()

    async def send_attachment(self, path, metadata, *, trusted_name=None):
        await super().send_attachment(
            path,
            metadata,
            trusted_name=trusted_name,
        )
        self.attachment_started.set()
        await self.release_attachment.wait()


class CapturingContext:
    def __init__(self):
        self.registration = None

    def register_platform(self, **kwargs):
        self.registration = kwargs


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.image_root = root / "images"
        self.audio_root = root / "audio"
        self.video_root = root / "videos"
        self.document_root = root / "documents"
        for cache_root in (
            self.image_root,
            self.audio_root,
            self.video_root,
            self.document_root,
        ):
            cache_root.mkdir()
        self.cache_patches = [
            mock.patch.object(hermes_base, "IMAGE_CACHE_DIR", self.image_root),
            mock.patch.object(hermes_base, "AUDIO_CACHE_DIR", self.audio_root),
            mock.patch.object(hermes_base, "VIDEO_CACHE_DIR", self.video_root),
            mock.patch.object(
                hermes_base,
                "DOCUMENT_CACHE_DIR",
                self.document_root,
            ),
        ]
        for patcher in self.cache_patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "BEARCODE_PLATFORM_KEY": "platform-secret",
                "BEARCODE_LISTEN_HOST": "127.0.0.1",
                "BEARCODE_LISTEN_PORT": "8643",
            },
            clear=False,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        approval.calls.clear()
        clarify_gateway.calls.clear()
        self.config = SimpleNamespace(extra={})
        self.adapter = BearCodeAdapter(
            self.config,
            server_factory=FakeServer,
        )

    async def asyncTearDown(self):
        self.directory.cleanup()

    def turn_start(self, text="Read this."):
        return {
            "type": "turn.start",
            "version": 1,
            "turnId": TURN_ID,
            "conversationId": CONVERSATION_ID,
            "text": text,
            "attachmentIds": [],
        }

    async def activate(self, connection=None):
        connection = connection or FakeConnection()
        await self.adapter.start_turn(
            connection,
            self.turn_start(),
            [],
        )
        event = self.adapter.handled_messages[-1]
        await self.adapter.on_processing_start(event)
        return connection, event

    def test_registration_uses_the_native_platform_contract(self):
        context = CapturingContext()
        register(context)

        registration = context.registration
        self.assertEqual(registration["name"], "bearcode")
        self.assertEqual(registration["label"], "BearCode")
        self.assertIsInstance(
            registration["adapter_factory"](self.config),
            BearCodeAdapter,
        )
        self.assertIs(registration["check_fn"], check_requirements)
        self.assertIs(registration["validate_config"], validate_config)
        self.assertIs(registration["is_connected"], is_connected)
        self.assertEqual(
            registration["required_env"],
            ["BEARCODE_PLATFORM_KEY"],
        )
        self.assertEqual(
            registration["install_hint"],
            "aiohttp is included in the Hermes runtime",
        )
        self.assertIs(registration["env_enablement_fn"], _env_enablement)
        self.assertEqual(registration["allowed_users_env"], "")
        self.assertEqual(
            registration["allow_all_env"],
            "BEARCODE_ALLOW_ALL_USERS",
        )
        self.assertEqual(registration["max_message_length"], 200000)
        self.assertEqual(registration["emoji"], "🐻")
        self.assertTrue(registration["pii_safe"])
        self.assertFalse(registration["allow_update_command"])
        self.assertIn(
            "MEDIA:/absolute/path/to/file",
            registration["platform_hint"],
        )
        self.assertIn(
            "whenever the user asks you to send a file",
            registration["platform_hint"],
        )

    def test_validate_config_requires_key_and_valid_port(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(validate_config(SimpleNamespace(extra={})))
            self.assertFalse(is_connected(SimpleNamespace(extra={})))

        cases = ("0", "65536", "not-a-port", "", True)
        for port in cases:
            with self.subTest(port=port):
                config = SimpleNamespace(
                    extra={
                        "platform_key": "secret",
                        "listen_port": port,
                    }
                )
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertFalse(validate_config(config))

        config = SimpleNamespace(
            extra={"platform_key": "secret", "listen_port": 8643}
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(validate_config(config))
            self.assertTrue(is_connected(config))

    def test_env_enablement_requires_key_and_preserves_nonsecret_settings(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(_env_enablement())
        with mock.patch.dict(
            os.environ,
            {
                "BEARCODE_PLATFORM_KEY": "secret",
                "BEARCODE_LISTEN_HOST": "100.64.0.1",
                "BEARCODE_LISTEN_PORT": "9876",
            },
            clear=True,
        ):
            self.assertEqual(
                _env_enablement(),
                {"listen_host": "100.64.0.1", "listen_port": 9876},
            )

    async def test_connect_and_disconnect_control_injected_server(self):
        self.assertEqual(self.adapter.platform.value, "bearcode")
        self.assertTrue(self.adapter.supports_status_text)
        self.assertTrue(self.adapter.REQUIRES_EDIT_FINALIZE)
        self.assertFalse(self.adapter.supports_async_delivery)

        self.assertTrue(await self.adapter.connect())

        server = self.adapter._server
        self.assertEqual(server.started, 1)
        self.assertIs(server.kwargs["delegate"], self.adapter)
        self.assertEqual(
            server.kwargs["outbound_roots"],
            (
                self.image_root,
                self.audio_root,
                self.video_root,
                self.document_root,
            ),
        )
        self.assertTrue(
            server.kwargs["temp_root"].is_relative_to(self.document_root)
        )
        self.assertFalse(
            server.kwargs["state_root"].is_relative_to(self.document_root)
        )
        self.assertIs(self.adapter._loop, asyncio.get_running_loop())

        await self.adapter.disconnect()
        self.assertEqual(server.stopped, 1)

    async def test_verified_uploads_become_cached_hermes_media_and_are_deleted(self):
        image_staging = Path(self.directory.name) / "staged-image.png"
        document_staging = Path(self.directory.name) / "staged-report.txt"
        image_bytes = b"\x89PNG\r\n\x1a\nverified"
        document_bytes = b"quarterly totals"
        image_staging.write_bytes(image_bytes)
        document_staging.write_bytes(document_bytes)
        uploads = [
            owned_upload(
                attachment_id=UUID(
                    "55555555-5555-4555-8555-555555555555"
                ),
                name="diagram.png",
                mime="image/png",
                size_bytes=len(image_bytes),
                sha256=hashlib.sha256(image_bytes).hexdigest(),
                path=image_staging,
            ),
            owned_upload(
                attachment_id=UUID(
                    "66666666-6666-4666-8666-666666666666"
                ),
                name="report.txt",
                mime="text/plain",
                size_bytes=len(document_bytes),
                sha256=hashlib.sha256(document_bytes).hexdigest(),
                path=document_staging,
            ),
        ]
        connection = FakeConnection()

        await self.adapter.start_turn(
            connection,
            self.turn_start(),
            uploads,
        )

        event = self.adapter.handled_messages[-1]
        self.assertEqual(event.text, "Read this.")
        self.assertEqual(event.message_type, MessageType.DOCUMENT)
        self.assertEqual(event.message_id, TURN_ID)
        self.assertEqual(event.metadata, {"bearcode_turn_id": TURN_ID})
        self.assertEqual(event.source.chat_id, CONVERSATION_ID)
        self.assertEqual(event.source.user_id, INSTALLATION_ID)
        self.assertEqual(event.source.message_id, TURN_ID)
        self.assertTrue(event.source.role_authorized)
        self.assertEqual(event.source.chat_name, "BearCode")
        self.assertEqual(event.source.user_name, "BearCode user")
        self.assertEqual(event.media_types, ["image/png", "text/plain"])
        self.assertEqual(
            [Path(path).read_bytes() for path in event.media_urls],
            [image_bytes, document_bytes],
        )
        self.assertFalse(image_staging.exists())
        self.assertFalse(document_staging.exists())

    async def test_only_images_use_photo_message_type(self):
        staging = Path(self.directory.name) / "staged-image.png"
        image_bytes = b"\x89PNG\r\n\x1a\nverified"
        staging.write_bytes(image_bytes)

        await self.adapter.start_turn(
            FakeConnection(),
            self.turn_start(),
            [
                owned_upload(
                    attachment_id=UUID(
                        "55555555-5555-4555-8555-555555555555"
                    ),
                    name="diagram.png",
                    mime="image/png",
                    size_bytes=16,
                    sha256=hashlib.sha256(image_bytes).hexdigest(),
                    path=staging,
                )
            ],
        )

        self.assertEqual(
            self.adapter.handled_messages[-1].message_type,
            MessageType.PHOTO,
        )

    async def test_verified_upload_uses_owned_inode_across_final_name_swaps(self):
        original = b"original"
        cases = ("replacement", "hard-link")
        for case in cases:
            with self.subTest(case=case):
                path = Path(self.directory.name) / f"{case}.verified"
                displaced = Path(self.directory.name) / f"{case}.original"
                replacement = Path(
                    self.directory.name
                ) / f"{case}.replacement"
                path.write_bytes(original)
                upload = owned_upload(
                    attachment_id=UUID(
                        "55555555-5555-4555-8555-555555555555"
                    ),
                    name="report.txt",
                    mime="text/plain",
                    size_bytes=len(original),
                    sha256=hashlib.sha256(original).hexdigest(),
                    path=path,
                )
                path.rename(displaced)
                replacement.write_bytes(b"replaced")
                if case == "hard-link":
                    os.link(replacement, path)
                else:
                    replacement.rename(path)

                await self.adapter.start_turn(
                    FakeConnection(),
                    self.turn_start(),
                    [upload],
                )

                event = self.adapter.handled_messages[-1]
                self.assertEqual(
                    Path(event.media_urls[0]).read_bytes(),
                    original,
                )
                self.assertEqual(path.read_bytes(), b"replaced")
                self.assertEqual(displaced.read_bytes(), b"")

    async def test_verified_upload_rejects_same_size_mutation_while_reading(self):
        path = Path(self.directory.name) / "mutating.verified"
        original = b"AAAABBBB"
        path.write_bytes(original)
        real_read = os.read
        reads = 0

        def mutate_after_first_read(descriptor, size):
            nonlocal reads
            chunk = real_read(descriptor, size)
            reads += 1
            if reads == 1:
                path.write_bytes(b"CCCCDDDD")
            return chunk

        upload = owned_upload(
            attachment_id=UUID(
                "55555555-5555-4555-8555-555555555555"
            ),
            name="report.txt",
            mime="text/plain",
            size_bytes=len(original),
            sha256=hashlib.sha256(original).hexdigest(),
            path=path,
        )
        with mock.patch.object(adapter_module, "MAX_CHUNK_BYTES", 4), (
            mock.patch.object(
                adapter_module.os,
                "read",
                mutate_after_first_read,
            )
        ):
            with self.assertRaises(ValueError):
                await self.adapter.start_turn(
                    FakeConnection(),
                    self.turn_start(),
                    [upload],
                )

        self.assertFalse(path.exists())

    async def test_inbound_cleanup_eio_is_retained_and_retried_on_disconnect(self):
        path = Path(self.directory.name) / "cleanup-eio.verified"
        data = b"verified"
        path.write_bytes(data)
        upload = owned_upload(
            attachment_id=UUID(
                "55555555-5555-4555-8555-555555555555"
            ),
            name="report.txt",
            mime="text/plain",
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            path=path,
        )
        real_ftruncate = os.ftruncate
        calls = 0

        def fail_once(descriptor, length):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError(errno.EIO, "simulated scrub failure")
            return real_ftruncate(descriptor, length)

        with mock.patch.object(
            adapter_module.os,
            "ftruncate",
            side_effect=fail_once,
        ):
            await self.adapter.start_turn(
                FakeConnection(),
                self.turn_start(),
                [upload],
            )

        self.assertTrue(path.exists())
        await self.adapter.disconnect()
        self.assertFalse(path.exists())

    async def test_disconnect_surfaces_persistent_cleanup_failure(self):
        path = Path(self.directory.name) / "persistent-eio.verified"
        data = b"verified"
        path.write_bytes(data)
        upload = owned_upload(
            attachment_id=UUID(
                "55555555-5555-4555-8555-555555555555"
            ),
            name="report.txt",
            mime="text/plain",
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            path=path,
        )
        with mock.patch.object(
            adapter_module.os,
            "ftruncate",
            side_effect=OSError(errno.EIO, "persistent failure"),
        ):
            await self.adapter.start_turn(
                FakeConnection(),
                self.turn_start(),
                [upload],
            )
            with self.assertRaises(adapter_module._StagedCleanupError):
                await self.adapter.disconnect()

        self.assertTrue(path.exists())
        self.assertTrue(self.adapter._cleanup_owner._pending)

    async def test_external_cleanup_eacces_is_retained_and_retried_on_disconnect(self):
        connection, _ = await self.activate()
        source = Path(self.directory.name) / "cleanup-eacces.txt"
        source.write_bytes(b"external")
        real_unlink = os.unlink
        calls = 0

        def fail_once(path, *args, **kwargs):
            nonlocal calls
            if ".attachment" in str(path) and calls == 0:
                calls += 1
                raise PermissionError(
                    errno.EACCES,
                    "simulated unlink failure",
                )
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(
            adapter_module.os,
            "unlink",
            side_effect=fail_once,
        ):
            result = await self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )

        self.assertTrue(result.success)
        staged = connection.attachments[-1][0]
        self.assertTrue(staged.exists())
        await self.adapter.disconnect()
        self.assertFalse(staged.exists())

    async def test_external_partial_cleanup_failure_is_retried_on_disconnect(self):
        await self.activate()
        source = Path(self.directory.name) / "partial-cleanup.txt"
        source.write_bytes(b"external")
        real_unlink = os.unlink
        failed_unlink = False

        def fail_partial_once(path, *args, **kwargs):
            nonlocal failed_unlink
            if ".partial" in str(path) and not failed_unlink:
                failed_unlink = True
                raise PermissionError(errno.EACCES, "simulated")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(
            adapter_module.os,
            "read",
            side_effect=OSError(errno.EIO, "simulated copy failure"),
        ), mock.patch.object(
            adapter_module.os,
            "unlink",
            side_effect=fail_partial_once,
        ):
            result = await self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )

        self.assertFalse(result.success)
        staging_root = self.document_root / ".bearcode-transfers"
        self.assertEqual(len(list(staging_root.iterdir())), 1)
        await self.adapter.disconnect()
        self.assertEqual(list(staging_root.iterdir()), [])

    async def test_cleanup_retry_is_idempotent_after_unlink_then_close_error(self):
        root = Path(self.directory.name) / "owned-cleanup"
        root.mkdir()
        path = root / "owned"
        path.write_bytes(b"secret")
        parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        file_fd = os.open(path, os.O_RDWR)
        owned = adapter_module._OwnedStagedFile(
            file_fd,
            parent_fd,
            path.name,
            os.fstat(file_fd),
        )
        owner = adapter_module._StagedCleanupOwner()
        real_close = os.close
        failed_close = False

        def close_then_fail(descriptor):
            nonlocal failed_close
            if not path.exists() and not failed_close:
                failed_close = True
                real_close(descriptor)
                raise OSError(errno.EIO, "simulated close failure")
            return real_close(descriptor)

        with mock.patch.object(
            adapter_module.os,
            "close",
            side_effect=close_then_fail,
        ):
            self.assertFalse(owner.close(owned))

        self.assertFalse(path.exists())
        reuse_path = root / "reused"
        reuse_path.write_bytes(b"still open")
        reused_descriptor = os.open(reuse_path, os.O_RDONLY)
        self.assertEqual(reused_descriptor, file_fd)
        owner.retry()
        self.assertEqual(owner._pending, {})
        self.assertEqual(os.read(reused_descriptor, 10), b"still open")
        os.close(reused_descriptor)

    async def test_send_and_edit_stream_deltas_with_replacement_semantics(self):
        connection, _ = await self.activate()

        sent = await self.adapter.send(CONVERSATION_ID, "Hello")
        await self.adapter.edit_message(
            CONVERSATION_ID,
            sent.message_id,
            "Hello world",
        )
        await self.adapter.edit_message(
            CONVERSATION_ID,
            sent.message_id,
            "Hello corrected",
        )
        await self.adapter.edit_message(
            CONVERSATION_ID,
            sent.message_id,
            "Hello corrected",
            finalize=True,
        )

        UUID(sent.message_id)
        self.assertTrue(sent.success)
        self.assertEqual(
            connection.events,
            [
                (
                    "assistant.started",
                    {"messageId": sent.message_id},
                ),
                (
                    "assistant.delta",
                    {"messageId": sent.message_id, "text": "Hello"},
                ),
                (
                    "assistant.delta",
                    {"messageId": sent.message_id, "text": " world"},
                ),
                (
                    "assistant.delta",
                    {
                        "messageId": sent.message_id,
                        "text": "Hello corrected",
                        "replace": True,
                    },
                ),
                (
                    "assistant.completed",
                    {"messageId": sent.message_id},
                ),
            ],
        )

    async def test_outbound_hooks_reject_unowned_paths_and_stream_cache_files(self):
        connection, _ = await self.activate()
        unsafe = Path(self.directory.name) / "missing.txt"
        document = self.document_root / "analysis.pdf"
        image = self.image_root / "chart.png"
        document.write_bytes(b"%PDF")
        image.write_bytes(b"\x89PNG\r\n\x1a\n")

        rejected = await self.adapter.send_document(
            CONVERSATION_ID,
            str(unsafe),
            file_name="../../secret.txt",
        )
        document_result = await self.adapter.send_document(
            CONVERSATION_ID,
            str(document),
            caption="/private/path",
            file_name="../../analysis.pdf",
            metadata={"credential": "must-not-cross"},
        )
        image_result = await self.adapter.send_image_file(
            CONVERSATION_ID,
            str(image),
            metadata={"credential": "must-not-cross"},
        )

        self.assertFalse(rejected.success)
        self.assertTrue(document_result.success)
        self.assertTrue(image_result.success)
        self.assertEqual(
            [entry[0] for entry in connection.attachments],
            [document.resolve(), image.resolve()],
        )
        self.assertEqual(
            connection.attachment_names,
            ["analysis.pdf", "chart.png"],
        )
        for _, metadata in connection.attachments:
            self.assertEqual(set(metadata), {"id"})
            UUID(metadata["id"])

    async def test_hermes_validated_external_files_are_atomically_staged(self):
        connection, _ = await self.activate()
        staging_root = self.document_root / ".bearcode-transfers"
        project_root = Path(self.directory.name) / "project"
        screenshot_root = Path(self.directory.name) / "screenshots"
        operator_root = Path(self.directory.name) / "operator-allowed"
        for root in (project_root, screenshot_root, operator_root):
            root.mkdir()
        project = project_root / "report.txt"
        screenshot = screenshot_root / "capture.png"
        operator_file = operator_root / "export.csv"
        project.write_bytes(b"project artifact")
        screenshot.write_bytes(b"screenshot artifact")
        operator_file.write_bytes(b"operator artifact")
        symlink = project_root / "report-link.txt"
        symlink.symlink_to(project)
        with tempfile.TemporaryDirectory(dir="/tmp") as temp_root:
            temporary = Path(temp_root) / "temporary.txt"
            temporary.write_bytes(b"temporary artifact")
            sources = (
                project,
                temporary,
                screenshot,
                operator_file,
                symlink,
            )

            for source in sources:
                with self.subTest(source=source):
                    result = await self.adapter.send_document(
                        CONVERSATION_ID,
                        str(source),
                        caption="/host/path/must-not-cross",
                        file_name="../../must-not-cross.txt",
                        metadata={"credential": "must-not-cross"},
                    )

                    self.assertTrue(result.success)
                    staged, metadata = connection.attachments[-1]
                    self.assertTrue(staged.is_relative_to(staging_root))
                    self.assertNotIn(".partial", staged.name)
                    self.assertEqual(
                        connection.attachment_bytes[-1],
                        source.resolve().read_bytes(),
                    )
                    self.assertEqual(connection.attachment_modes[-1], 0o600)
                    self.assertEqual(
                        connection.attachment_names[-1],
                        source.resolve().name,
                    )
                    self.assertEqual(set(metadata), {"id"})
                    self.assertNotIn(str(source), repr(metadata))
                    self.assertFalse(staged.exists())
                    self.assertEqual(list(staging_root.iterdir()), [])

    async def test_external_source_parent_replacement_is_rejected(self):
        connection, _ = await self.activate()
        source_parent = Path(self.directory.name) / "validated"
        replacement_parent = Path(self.directory.name) / "replacement"
        held_parent = Path(self.directory.name) / "validated-held"
        source_parent.mkdir()
        replacement_parent.mkdir()
        source = source_parent / "report.txt"
        source.write_bytes(b"validated bytes")
        (replacement_parent / source.name).write_bytes(
            b"replacement bytes"
        )
        original_validator = self.adapter.validate_media_delivery_path
        calls = 0

        def replace_parent_after_validation(path):
            nonlocal calls
            calls += 1
            resolved = original_validator(path)
            if calls == 1:
                source_parent.rename(held_parent)
                source_parent.symlink_to(
                    replacement_parent,
                    target_is_directory=True,
                )
            return resolved

        with mock.patch.object(
            self.adapter,
            "validate_media_delivery_path",
            side_effect=replace_parent_after_validation,
        ):
            result = await self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )

        self.assertFalse(result.success)
        self.assertEqual(connection.attachments, [])
        self.assertEqual(
            list((self.document_root / ".bearcode-transfers").iterdir()),
            [],
        )

    async def test_external_source_growth_past_ten_mib_is_rejected(self):
        connection, _ = await self.activate()
        source = Path(self.directory.name) / "growing.txt"
        source.write_bytes(b"12345678")
        real_read = os.read
        read_count = 0

        def grow_after_first_read(descriptor, size):
            nonlocal read_count
            chunk = real_read(descriptor, size)
            read_count += 1
            if read_count == 1:
                with source.open("ab") as handle:
                    handle.write(b"9")
            return chunk

        with mock.patch.object(adapter_module, "MAX_FILE_BYTES", 8), (
            mock.patch.object(adapter_module, "MAX_CHUNK_BYTES", 4)
        ), mock.patch.object(adapter_module.os, "read", grow_after_first_read):
            result = await self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )

        self.assertFalse(result.success)
        self.assertEqual(connection.attachments, [])
        self.assertEqual(
            list((self.document_root / ".bearcode-transfers").iterdir()),
            [],
        )

    async def test_external_same_size_rewrite_cannot_create_mixed_snapshot(self):
        connection, _ = await self.activate()
        source = Path(self.directory.name) / "rewritten.txt"
        source.write_bytes(b"AAAABBBB")
        original_info = source.stat()
        real_read = os.read
        read_count = 0

        def rewrite_after_first_read(descriptor, size):
            nonlocal read_count
            chunk = real_read(descriptor, size)
            read_count += 1
            if read_count == 1:
                source.write_bytes(b"CCCCDDDD")
                os.utime(
                    source,
                    ns=(
                        original_info.st_atime_ns,
                        original_info.st_mtime_ns,
                    ),
                )
            return chunk

        with mock.patch.object(adapter_module, "MAX_CHUNK_BYTES", 4), (
            mock.patch.object(
                adapter_module.os,
                "read",
                rewrite_after_first_read,
            )
        ):
            result = await self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )

        self.assertFalse(result.success)
        self.assertEqual(connection.attachments, [])
        self.assertEqual(
            list((self.document_root / ".bearcode-transfers").iterdir()),
            [],
        )

    async def test_external_staging_is_cleaned_after_send_failure(self):
        connection = FailingAttachmentConnection()
        await self.activate(connection)
        source = Path(self.directory.name) / "failure.txt"
        source.write_bytes(b"failure bytes")

        result = await self.adapter.send_document(
            CONVERSATION_ID,
            str(source),
        )

        self.assertFalse(result.success)
        staged = connection.attachments[-1][0]
        self.assertTrue(
            staged.is_relative_to(
                self.document_root / ".bearcode-transfers"
            )
        )
        self.assertFalse(staged.exists())
        self.assertEqual(
            list((self.document_root / ".bearcode-transfers").iterdir()),
            [],
        )

    async def test_external_staging_is_cleaned_after_cancellation(self):
        connection = BlockingAttachmentConnection()
        await self.activate(connection)
        source = Path(self.directory.name) / "cancelled.txt"
        source.write_bytes(b"cancelled bytes")

        delivery = asyncio.create_task(
            self.adapter.send_document(
                CONVERSATION_ID,
                str(source),
            )
        )
        await connection.attachment_started.wait()
        staged = connection.attachments[-1][0]
        delivery.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await delivery

        self.assertFalse(staged.exists())
        self.assertEqual(
            list((self.document_root / ".bearcode-transfers").iterdir()),
            [],
        )

    async def test_approval_and_clarification_resolutions_enforce_connection_ownership(self):
        connection, _ = await self.activate()
        wrong_connection = FakeConnection()

        approval_result = await self.adapter.send_exec_approval(
            CONVERSATION_ID,
            "git status",
            SESSION_KEY,
            description="Inspect repository status",
            allow_permanent=False,
            allow_session=True,
            smart_denied=True,
        )
        approval_event = connection.events[-1]
        self.assertEqual(approval_event[0], "approval.requested")
        self.assertEqual(
            approval_event[1],
            {
                "requestId": approval_result.message_id,
                "toolCallId": mock.ANY,
                "command": "git status",
                "description": "Inspect repository status",
                "allowSession": True,
                "allowPermanent": False,
                "smartDenied": True,
            },
        )
        UUID(approval_event[1]["toolCallId"])
        self.assertFalse(
            await self.adapter.resolve_approval(
                wrong_connection,
                approval_result.message_id,
                "once",
            )
        )
        self.assertEqual(approval.calls, [])
        self.assertTrue(
            await self.adapter.resolve_approval(
                connection,
                approval_result.message_id,
                "once",
            )
        )
        self.assertEqual(
            approval.calls,
            [(SESSION_KEY, "once", False, None)],
        )

        clarify_id = "77777777-7777-4777-8777-777777777777"
        clarify_result = await self.adapter.send_clarify(
            CONVERSATION_ID,
            "Which totals?",
            ["Monthly", "Quarterly"],
            clarify_id,
            SESSION_KEY,
        )
        self.assertEqual(clarify_result.message_id, clarify_id)
        self.assertEqual(
            connection.events[-1],
            (
                "clarification.requested",
                {
                    "requestId": clarify_id,
                    "question": "Which totals?",
                    "choices": ["Monthly", "Quarterly"],
                },
            ),
        )
        self.assertFalse(
            await self.adapter.resolve_clarification(
                wrong_connection,
                clarify_id,
                "Quarterly",
            )
        )
        self.assertTrue(
            await self.adapter.resolve_clarification(
                connection,
                clarify_id,
                "Quarterly",
            )
        )
        self.assertEqual(
            clarify_gateway.calls,
            [(clarify_id, "Quarterly")],
        )

    async def test_requests_are_owned_before_reentrant_response_and_roll_back_on_failure(self):
        connection, _ = await self.activate()
        original_send = connection.send_event
        resolutions = []

        async def reentrant_send(event_type, payload):
            await original_send(event_type, payload)
            if event_type == "approval.requested":
                resolutions.append(
                    await self.adapter.resolve_approval(
                        connection,
                        payload["requestId"],
                        "once",
                    )
                )
            elif event_type == "clarification.requested":
                resolutions.append(
                    await self.adapter.resolve_clarification(
                        connection,
                        payload["requestId"],
                        "Yes",
                    )
                )

        connection.send_event = reentrant_send
        approval_result = await self.adapter.send_exec_approval(
            CONVERSATION_ID,
            "git status",
            SESSION_KEY,
        )
        clarify_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        clarify_result = await self.adapter.send_clarify(
            CONVERSATION_ID,
            "Continue?",
            ["Yes", "No"],
            clarify_id,
            SESSION_KEY,
        )

        self.assertTrue(approval_result.success)
        self.assertTrue(clarify_result.success)
        self.assertEqual(resolutions, [True, True])
        self.assertEqual(self.adapter._approval_requests, {})
        self.assertEqual(self.adapter._clarification_requests, {})

        async def failing_send(event_type, payload):
            del event_type, payload
            raise ConnectionError("simulated request send failure")

        connection.send_event = failing_send
        failed_approval = await self.adapter.send_exec_approval(
            CONVERSATION_ID,
            "npm test",
            SESSION_KEY,
        )
        failed_clarify = await self.adapter.send_clarify(
            CONVERSATION_ID,
            "Retry?",
            None,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            SESSION_KEY,
        )
        self.assertFalse(failed_approval.success)
        self.assertFalse(failed_clarify.success)
        self.assertEqual(self.adapter._approval_requests, {})
        self.assertEqual(self.adapter._clarification_requests, {})

    async def test_worker_thread_status_updates_schedule_tool_lifecycle_on_loop(self):
        await self.adapter.connect()
        connection, _ = await self.activate()

        await asyncio.to_thread(
            self.adapter.set_status_text,
            CONVERSATION_ID,
            "is running pytest",
        )
        await asyncio.sleep(0)
        await asyncio.to_thread(
            self.adapter.set_status_text,
            CONVERSATION_ID,
            "is checking results",
        )
        await asyncio.sleep(0)
        approval_result = await self.adapter.send_exec_approval(
            CONVERSATION_ID,
            "npm test",
            SESSION_KEY,
        )
        await asyncio.to_thread(
            self.adapter.set_status_text,
            CONVERSATION_ID,
            None,
        )
        await asyncio.sleep(0)

        started = connection.events[0]
        progress = connection.events[1]
        requested = connection.events[2]
        completed = connection.events[3]
        self.assertEqual(started[0], "tool.started")
        self.assertEqual(started[1]["name"], "_status")
        self.assertEqual(
            started[1]["label"],
            "is running pytest",
        )
        tool_call_id = started[1]["toolCallId"]
        UUID(tool_call_id)
        self.assertEqual(
            progress,
            (
                "tool.progress",
                {
                    "toolCallId": tool_call_id,
                    "label": "is checking results",
                },
            ),
        )
        self.assertEqual(
            requested[1]["requestId"],
            approval_result.message_id,
        )
        self.assertEqual(requested[1]["toolCallId"], tool_call_id)
        self.assertEqual(
            completed,
            (
                "tool.completed",
                {"toolCallId": tool_call_id, "status": "completed"},
            ),
        )

    async def test_status_callback_queued_before_disconnect_is_a_safe_noop(self):
        await self.adapter.connect()
        connection, _ = await self.activate()
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        loop_errors = []
        loop.set_exception_handler(
            lambda unused_loop, context: loop_errors.append(context)
        )
        try:
            self.adapter.set_status_text(
                CONVERSATION_ID,
                "must not cross disconnect",
            )
            await self.adapter.disconnect()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        finally:
            loop.set_exception_handler(previous_handler)

        self.assertEqual(loop_errors, [])
        self.assertEqual(connection.events, [])
        self.assertEqual(self.adapter._status_tools, {})

    async def test_status_update_cannot_cross_same_chat_turn_generation(self):
        await self.adapter.connect()
        connection_a, _ = await self.activate()
        self.adapter.set_status_text(CONVERSATION_ID, "queued for A")

        connection_b = FakeConnection()
        payload_b = self.turn_start("Turn B.")
        payload_b["turnId"] = SECOND_TURN_ID
        await self.adapter.start_turn(connection_b, payload_b, [])
        event_b = self.adapter.handled_messages[-1]
        await self.adapter.on_processing_start(event_b)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        self.assertEqual(connection_a.events, [])
        self.assertEqual(connection_b.events, [])
        self.assertEqual(self.adapter._status_tools, {})

        original_send = connection_b.send_event
        connection_c = FakeConnection()

        async def replace_during_send(event_type, payload):
            await original_send(event_type, payload)
            payload_c = self.turn_start("Turn C.")
            payload_c["turnId"] = (
                "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            )
            await self.adapter.start_turn(connection_c, payload_c, [])
            event_c = self.adapter.handled_messages[-1]
            await self.adapter.on_processing_start(event_c)

        connection_b.send_event = replace_during_send
        self.adapter.set_status_text(CONVERSATION_ID, "started for B")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        self.assertEqual(
            [event_type for event_type, _ in connection_b.events],
            ["tool.started"],
        )
        self.assertEqual(connection_c.events, [])
        self.assertEqual(self.adapter._status_tools, {})

    async def test_delayed_status_clear_uses_original_worker_turn_binding(self):
        await self.adapter.connect()
        connection_a, _ = await self.activate()
        with mock.patch.object(
            adapter_module.threading,
            "get_ident",
            return_value=101,
        ):
            self.adapter.set_status_text(CONVERSATION_ID, "A status")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        connection_b = FakeConnection()
        payload_b = self.turn_start("Turn B.")
        payload_b["turnId"] = SECOND_TURN_ID
        await self.adapter.start_turn(connection_b, payload_b, [])
        event_b = self.adapter.handled_messages[-1]
        await self.adapter.on_processing_start(event_b)
        with mock.patch.object(
            adapter_module.threading,
            "get_ident",
            return_value=202,
        ):
            self.adapter.set_status_text(CONVERSATION_ID, "B status")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        with mock.patch.object(
            adapter_module.threading,
            "get_ident",
            return_value=101,
        ):
            self.adapter.set_status_text(CONVERSATION_ID, None)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        self.assertEqual(
            [event_type for event_type, _ in connection_b.events],
            ["tool.started"],
        )
        self.assertEqual(
            self.adapter._status_tools[CONVERSATION_ID]["label"],
            "B status",
        )

    async def test_status_producer_cannot_register_after_turn_cleanup(self):
        await self.adapter.connect()
        connection, _ = await self.activate()
        self.adapter._cleanup_connection(connection)

        await asyncio.to_thread(
            self.adapter.set_status_text,
            CONVERSATION_ID,
            "too late",
        )
        await asyncio.sleep(0)

        with self.adapter._status_producers_lock:
            self.assertEqual(self.adapter._status_producers, {})
        self.assertEqual(self.adapter._status_tools, {})

    async def test_stale_event_completion_cannot_terminate_new_same_chat_turn(self):
        connection_a = FakeConnection()
        await self.adapter.start_turn(
            connection_a,
            self.turn_start("First turn."),
            [],
        )
        event_a = self.adapter.handled_messages[-1]
        await self.adapter.on_processing_start(event_a)

        connection_b = FakeConnection()
        event_b_payload = self.turn_start("Second turn.")
        event_b_payload["turnId"] = SECOND_TURN_ID
        await self.adapter.start_turn(
            connection_b,
            event_b_payload,
            [],
        )
        event_b = self.adapter.handled_messages[-1]
        await self.adapter.on_processing_start(event_b)

        await self.adapter.on_processing_complete(
            event_a,
            ProcessingOutcome.SUCCESS,
        )
        await self.adapter.on_processing_complete(
            event_a,
            ProcessingOutcome.FAILURE,
        )

        self.assertEqual(
            connection_a.terminals,
            [("turn.completed", {"sessionId": SESSION_KEY})],
        )
        self.assertEqual(connection_b.terminals, [])
        self.assertIs(
            self.adapter._connections_by_chat[CONVERSATION_ID],
            connection_b,
        )

        await self.adapter.on_processing_complete(
            event_b,
            ProcessingOutcome.CANCELLED,
        )
        self.assertEqual(
            connection_b.terminals,
            [("turn.cancelled", {})],
        )

    async def test_disconnect_clears_every_turn_ownership_map(self):
        await self.adapter.connect()
        connection, event = await self.activate()
        sent = await self.adapter.send(CONVERSATION_ID, "final answer")
        await self.adapter.edit_message(
            CONVERSATION_ID,
            sent.message_id,
            "final answer",
            finalize=True,
        )
        await self.adapter.send_exec_approval(
            CONVERSATION_ID,
            "git status",
            SESSION_KEY,
        )
        await self.adapter.send_clarify(
            CONVERSATION_ID,
            "Continue?",
            ["Yes", "No"],
            "99999999-9999-4999-8999-999999999999",
            SESSION_KEY,
        )
        self.adapter._status_tools[CONVERSATION_ID] = {
            "id": "status-id",
            "label": "working",
        }
        self.adapter._terminating_connections.add(connection)
        pending_connection = FakeConnection()
        await self.adapter.start_turn(
            pending_connection,
            self.turn_start("Pending turn."),
            [],
        )

        self.assertTrue(self.adapter._pending_connections)
        self.assertTrue(self.adapter._messages)
        self.assertTrue(self.adapter._message_connections)
        self.assertTrue(self.adapter._finalized_messages)
        self.assertTrue(self.adapter._terminating_connections)
        self.assertIsNotNone(event)

        await self.adapter.disconnect()

        empty_mappings = (
            "_pending_connections",
            "_connections_by_chat",
            "_connections_by_event",
            "_turns_by_chat",
            "_sources_by_connection",
            "_messages",
            "_message_connections",
            "_status_tools",
            "_approval_requests",
            "_clarification_requests",
        )
        for attribute in empty_mappings:
            with self.subTest(attribute=attribute):
                self.assertEqual(
                    getattr(self.adapter, attribute, None),
                    {},
                )
        self.assertEqual(self.adapter._finalized_messages, set())
        self.assertEqual(self.adapter._terminating_connections, set())
        self.assertEqual(self.adapter._cleanup_owner._pending, {})

    async def test_processing_completion_emits_one_terminal_and_exact_session_key(self):
        connection, event = await self.activate()

        await self.adapter.on_processing_complete(
            event,
            ProcessingOutcome.SUCCESS,
        )
        await self.adapter.on_processing_complete(
            event,
            ProcessingOutcome.FAILURE,
        )

        self.assertEqual(
            connection.terminals,
            [("turn.completed", {"sessionId": SESSION_KEY})],
        )
        self.assertTrue(connection.closed)

    async def test_processing_failure_and_cancellation_map_terminal_events(self):
        cases = (
            (
                ProcessingOutcome.FAILURE,
                "turn.failed",
                {
                    "error": {
                        "code": "hermes.turn_failed",
                        "message": "Hermes could not complete the turn.",
                        "retryable": False,
                    }
                },
            ),
            (ProcessingOutcome.CANCELLED, "turn.cancelled", {}),
        )
        for outcome, event_type, payload in cases:
            with self.subTest(outcome=outcome):
                adapter = BearCodeAdapter(
                    self.config,
                    server_factory=FakeServer,
                )
                connection = FakeConnection()
                await adapter.start_turn(
                    connection,
                    self.turn_start(),
                    [],
                )
                event = adapter.handled_messages[-1]
                await adapter.on_processing_start(event)
                await adapter.on_processing_complete(event, outcome)
                self.assertEqual(
                    connection.terminals,
                    [(event_type, payload)],
                )

    async def test_cancel_turn_uses_the_same_session_key_as_handle_message(self):
        connection, _ = await self.activate()

        await self.adapter.cancel_turn(connection)

        self.assertEqual(
            self.adapter.cancelled_sessions,
            [(SESSION_KEY, True, True)],
        )

    async def test_handle_message_failure_rolls_back_pending_turn_ownership(self):
        connection = FakeConnection()
        with mock.patch.object(
            self.adapter,
            "handle_message",
            side_effect=RuntimeError("simulated Hermes rejection"),
        ):
            with self.assertRaises(RuntimeError):
                await self.adapter.start_turn(
                    connection,
                    self.turn_start(),
                    [],
                )

        self.assertEqual(self.adapter._pending_connections, {})
        self.assertNotIn(connection, self.adapter._sources_by_connection)

    async def test_handle_message_failure_rolls_back_reentrant_active_ownership(self):
        connection = FakeConnection()

        async def start_then_fail(event):
            await self.adapter.on_processing_start(event)
            raise RuntimeError("simulated post-start failure")

        with mock.patch.object(
            self.adapter,
            "handle_message",
            side_effect=start_then_fail,
        ):
            with self.assertRaises(RuntimeError):
                await self.adapter.start_turn(
                    connection,
                    self.turn_start(),
                    [],
                )

        self.assertEqual(self.adapter._pending_connections, {})
        self.assertEqual(self.adapter._connections_by_event, {})
        self.assertEqual(self.adapter._connections_by_chat, {})
        self.assertEqual(self.adapter._turns_by_chat, {})
        self.assertNotIn(connection, self.adapter._sources_by_connection)


if __name__ == "__main__":
    unittest.main()
