import asyncio
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import UUID

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
SESSION_KEY = f"agent:main:bearcode:dm:{CONVERSATION_ID}"


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
        self.terminals = []
        self.closed = False

    async def send_event(self, event_type, payload):
        self.events.append((event_type, payload))

    async def send_attachment(self, path, metadata):
        self.attachments.append((Path(path), dict(metadata)))

    async def mark_terminal(self, event_type, payload):
        self.terminals.append((event_type, payload))
        await self.close()

    async def close(self):
        self.closed = True


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
            VerifiedUpload(
                attachment_id=UUID(
                    "55555555-5555-4555-8555-555555555555"
                ),
                name="diagram.png",
                mime="image/png",
                size_bytes=len(image_bytes),
                sha256="unused",
                path=image_staging,
            ),
            VerifiedUpload(
                attachment_id=UUID(
                    "66666666-6666-4666-8666-666666666666"
                ),
                name="report.txt",
                mime="text/plain",
                size_bytes=len(document_bytes),
                sha256="unused",
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
        staging.write_bytes(b"\x89PNG\r\n\x1a\nverified")

        await self.adapter.start_turn(
            FakeConnection(),
            self.turn_start(),
            [
                VerifiedUpload(
                    attachment_id=UUID(
                        "55555555-5555-4555-8555-555555555555"
                    ),
                    name="diagram.png",
                    mime="image/png",
                    size_bytes=16,
                    sha256="unused",
                    path=staging,
                )
            ],
        )

        self.assertEqual(
            self.adapter.handled_messages[-1].message_type,
            MessageType.PHOTO,
        )

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
        unsafe = Path(self.directory.name) / "outside.txt"
        unsafe.write_text("outside")
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
        for _, metadata in connection.attachments:
            self.assertEqual(set(metadata), {"id"})
            UUID(metadata["id"])

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


if __name__ == "__main__":
    unittest.main()
