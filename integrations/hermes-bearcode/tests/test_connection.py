import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from uuid import UUID

from aiohttp import WSMessage, WSMsgType

sys.path.insert(0, str(Path(__file__).parents[1]))

from bearcode_transport.connection import (
    BearCodeConnection,
    ConnectionRegistry,
    ConnectionState,
)
from bearcode_transport.ledger import TurnLedger
from bearcode_transport.protocol import (
    BinaryChunk,
    BinaryDirection,
    MAX_FILE_BYTES,
    decode_binary_frame,
    encode_binary_frame,
    encode_event,
)


CONVERSATION_ID = "11111111-1111-4111-8111-111111111111"
OTHER_CONVERSATION_ID = "12111111-1111-4111-8111-111111111111"
INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
TURN_ID = "44444444-4444-4444-8444-444444444444"
ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555"
REQUEST_ID = "66666666-6666-4666-8666-666666666666"


def hello(conversation_id=CONVERSATION_ID, versions=None):
    return {
        "type": "hello",
        "protocol": "bearcode-hermes",
        "versions": [1] if versions is None else versions,
        "client": {"name": "BearCode", "version": "1.0.0"},
        "conversationId": conversation_id,
        "installationId": INSTALLATION_ID,
    }


def turn_start(
    conversation_id=CONVERSATION_ID,
    turn_id=TURN_ID,
    attachment_ids=None,
):
    return {
        "type": "turn.start",
        "version": 1,
        "turnId": turn_id,
        "conversationId": conversation_id,
        "text": "Read this.",
        "attachmentIds": [] if attachment_ids is None else attachment_ids,
    }


def upload_begin(data=b"hello", turn_id=TURN_ID):
    return {
        "type": "attachment.upload.begin",
        "version": 1,
        "turnId": turn_id,
        "attachment": {
            "id": ATTACHMENT_ID,
            "name": "report.txt",
            "declaredMime": "text/plain",
            "kind": "file",
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    }


class FakeWebSocket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent_text = []
        self.sent_bytes = []
        self.closed = False
        self.close_code = None

    async def receive(self):
        return await self.incoming.get()

    async def send_str(self, raw):
        if self.closed:
            raise ConnectionError("websocket is closed")
        self.sent_text.append(json.loads(raw))

    async def send_bytes(self, raw):
        if self.closed:
            raise ConnectionError("websocket is closed")
        self.sent_bytes.append(raw)

    async def close(self, code=1000, message=b""):
        if not self.closed:
            self.closed = True
            self.close_code = code
            self.close_message = message
            await self.incoming.put(WSMessage(WSMsgType.CLOSE, code, message))

    async def feed_json(self, event):
        await self.incoming.put(
            WSMessage(WSMsgType.TEXT, encode_event(event), "")
        )

    async def feed_binary(self, raw):
        await self.incoming.put(WSMessage(WSMsgType.BINARY, raw, ""))

    async def disconnect(self):
        await self.close()


class FakeDelegate:
    def __init__(self):
        self.started = []
        self.cancelled = []
        self.approvals = []
        self.clarifications = []

    async def start_turn(self, connection, event, uploads):
        self.started.append((connection, event, uploads))

    async def cancel_turn(self, connection):
        self.cancelled.append(connection)

    async def resolve_approval(self, connection, request_id, decision):
        self.approvals.append((connection, request_id, decision))
        return True

    async def resolve_clarification(self, connection, request_id, response):
        self.clarifications.append((connection, request_id, response))
        return True


class FailingCancelDelegate(FakeDelegate):
    async def cancel_turn(self, connection):
        self.cancelled.append(connection)
        raise RuntimeError("cancel failed")


class BlockingCancelDelegate(FakeDelegate):
    def __init__(self):
        super().__init__()
        self.cancel_started = asyncio.Event()
        self.allow_cancel = asyncio.Event()

    async def cancel_turn(self, connection):
        self.cancelled.append(connection)
        self.cancel_started.set()
        await self.allow_cancel.wait()


class TurnLedgerTests(unittest.TestCase):
    @staticmethod
    def fill_accepted(ledger, count=1024):
        for index in range(count):
            ledger.accept(UUID(int=index + 1), CONVERSATION_ID)

    def test_ledger_and_parent_have_restricted_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / "state"
            ledger = TurnLedger(state_root)
            try:
                self.assertEqual(state_root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(ledger.path.stat().st_mode & 0o777, 0o600)
            finally:
                ledger.close()

    def test_terminal_rows_older_than_seven_days_are_pruned(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = TurnLedger(Path(directory) / "state")
            try:
                accepted, _ = ledger.accept(TURN_ID, CONVERSATION_ID)
                self.assertTrue(accepted)
                ledger.mark_terminal(TURN_ID, "completed")
                with sqlite3.connect(ledger.path) as database:
                    database.execute(
                        """
                        UPDATE bearcode_turns
                        SET updated_at = 0
                        WHERE turn_id = ?
                        """,
                        (TURN_ID,),
                    )
                ledger.prune(now=7 * 24 * 60 * 60 + 1)
                self.assertIsNone(ledger.get(TURN_ID))
            finally:
                ledger.close()

    def test_ledger_retains_no_more_than_1024_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = TurnLedger(Path(directory) / "state")
            try:
                for index in range(1024):
                    ledger.accept(UUID(int=index + 1), CONVERSATION_ID)
                with sqlite3.connect(ledger.path) as database:
                    count = database.execute(
                        "SELECT COUNT(*) FROM bearcode_turns"
                    ).fetchone()[0]
                self.assertEqual(count, 1024)
            finally:
                ledger.close()

    def test_capacity_never_evicts_accepted_turns(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = TurnLedger(Path(directory) / "state")
            try:
                self.fill_accepted(ledger)
                with self.assertRaises(Exception) as raised:
                    ledger.accept(UUID(int=2048), CONVERSATION_ID)

                self.assertEqual(
                    type(raised.exception).__name__,
                    "LedgerCapacityError",
                )
                self.assertTrue(raised.exception.retryable)
                self.assertEqual(
                    raised.exception.code,
                    "persistence.turn_ledger_full",
                )
                for index in range(1024):
                    self.assertIsNotNone(ledger.get(UUID(int=index + 1)))
                self.assertIsNone(ledger.get(UUID(int=2048)))
            finally:
                ledger.close()

    def test_capacity_evicts_oldest_terminal_before_new_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = TurnLedger(Path(directory) / "state")
            try:
                self.fill_accepted(ledger)
                oldest_terminal = UUID(int=1)
                newer_terminal = UUID(int=2)
                ledger.mark_terminal(oldest_terminal, "completed")
                ledger.mark_terminal(newer_terminal, "failed")
                now = int(time.time())
                with sqlite3.connect(ledger.path) as database:
                    database.execute(
                        """
                        UPDATE bearcode_turns
                        SET updated_at = CASE turn_id
                          WHEN ? THEN ?
                          WHEN ? THEN ?
                          ELSE updated_at
                        END
                        """,
                        (
                            str(oldest_terminal),
                            now - 2,
                            str(newer_terminal),
                            now - 1,
                        ),
                    )

                new_turn = UUID(int=2048)
                accepted, record = ledger.accept(new_turn, CONVERSATION_ID)

                self.assertTrue(accepted)
                self.assertEqual(record.turn_id, str(new_turn))
                self.assertIsNone(ledger.get(oldest_terminal))
                self.assertEqual(ledger.get(newer_terminal).status, "failed")
                self.assertEqual(ledger.get(UUID(int=3)).status, "accepted")
                self.assertEqual(ledger.get(new_turn).status, "accepted")
            finally:
                ledger.close()

    def test_capacity_pressure_survives_restart_and_terminal_update(self):
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / "state"
            ledger = TurnLedger(state_root)
            self.fill_accepted(ledger)
            ledger.close()

            replacement = TurnLedger(state_root)
            try:
                with self.assertRaises(Exception) as raised:
                    replacement.accept(UUID(int=2048), CONVERSATION_ID)
                self.assertEqual(
                    type(raised.exception).__name__,
                    "LedgerCapacityError",
                )
                replacement.mark_terminal(UUID(int=1), "cancelled")
                accepted, record = replacement.accept(
                    UUID(int=2048),
                    CONVERSATION_ID,
                )

                self.assertTrue(accepted)
                self.assertEqual(record.status, "accepted")
                self.assertIsNone(replacement.get(UUID(int=1)))
                self.assertEqual(
                    replacement.get(UUID(int=2)).status,
                    "accepted",
                )
            finally:
                replacement.close()


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.temp_root = self.root / "uploads"
        self.temp_root.mkdir()
        self.state_root = self.root / "state"
        self.delegate = FakeDelegate()
        self.ledger = TurnLedger(self.state_root)
        self.registry = ConnectionRegistry(self.ledger)
        self.connections = []

    async def asyncTearDown(self):
        for connection, task, websocket in reversed(self.connections):
            if not websocket.closed:
                await websocket.disconnect()
            await asyncio.wait_for(task, 1)
        self.ledger.close()
        self.directory.cleanup()

    async def connect(
        self,
        *,
        registry=None,
        delegate=None,
        conversation_id=CONVERSATION_ID,
        outbound_roots=None,
        heartbeat_interval=3600,
        heartbeat_timeout=3600,
        preturn_timeout=3600,
    ):
        websocket = FakeWebSocket()
        connection = BearCodeConnection(
            websocket=websocket,
            registry=self.registry if registry is None else registry,
            delegate=self.delegate if delegate is None else delegate,
            temp_root=self.temp_root,
            outbound_roots=outbound_roots,
            heartbeat_interval=heartbeat_interval,
            heartbeat_timeout=heartbeat_timeout,
            preturn_timeout=preturn_timeout,
        )
        task = asyncio.create_task(connection.run())
        self.connections.append((connection, task, websocket))
        await websocket.feed_json(hello(conversation_id))
        await self.wait_for_event(websocket, "hello.accepted")
        return connection, task, websocket

    async def wait_for_event(self, websocket, event_type, timeout=1):
        async def find_event():
            while True:
                for event in websocket.sent_text:
                    if event["type"] == event_type:
                        return event
                await asyncio.sleep(0)

        return await asyncio.wait_for(find_event(), timeout)

    @staticmethod
    def outbound_metadata(attachment_id):
        return {
            "id": str(attachment_id),
            "name": "ignored.txt",
        }

    async def test_state_order_is_pinned(self):
        self.assertEqual(
            [state.name for state in ConnectionState],
            [
                "CONNECTED",
                "HELLO",
                "UPLOADING",
                "READY",
                "ACCEPTED",
                "TERMINAL",
                "CLOSED",
            ],
        )

    async def test_turn_start_fails_while_upload_is_unfinished(self):
        _, task, websocket = await self.connect()
        await websocket.feed_json(upload_begin())
        await self.wait_for_event(websocket, "attachment.upload.accepted")
        await websocket.feed_json(turn_start(attachment_ids=[ATTACHMENT_ID]))
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertEqual(self.delegate.started, [])
        self.assertEqual(list(self.temp_root.iterdir()), [])

    async def test_turn_start_rejects_more_than_five_attachments(self):
        _, task, websocket = await self.connect()
        attachment_ids = [
            str(UUID(int=index + 1)) for index in range(6)
        ]
        await websocket.feed_json(turn_start(attachment_ids=attachment_ids))
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertEqual(self.delegate.started, [])

    async def test_turn_start_rejects_unknown_attachment_ids(self):
        _, task, websocket = await self.connect()
        await websocket.feed_json(turn_start(attachment_ids=[ATTACHMENT_ID]))
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertEqual(self.delegate.started, [])

    async def test_turn_capacity_rejects_before_delegate_execution(self):
        TurnLedgerTests.fill_accepted(self.ledger)
        _, task, websocket = await self.connect()
        await websocket.feed_json(
            turn_start(turn_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        )
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertEqual(websocket.close_code, 1013)
        self.assertEqual(
            websocket.close_message,
            b"persistence.turn_ledger_full",
        )
        self.assertEqual(self.delegate.started, [])
        self.assertIsNone(
            self.ledger.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        )

    async def test_duplicate_turn_reports_known_state_without_reexecution(self):
        first, first_task, first_ws = await self.connect()
        await first_ws.feed_json(turn_start())
        await self.wait_for_event(first_ws, "turn.accepted")
        await first.mark_terminal("turn.completed", {"sessionId": "session"})
        await first_ws.disconnect()
        await asyncio.wait_for(first_task, 1)

        second, second_task, second_ws = await self.connect()
        await second_ws.feed_json(turn_start())
        duplicate = await self.wait_for_event(second_ws, "turn.duplicate")
        await asyncio.wait_for(second_task, 1)

        self.assertEqual(duplicate["payload"], {"status": "completed"})
        self.assertEqual(len(self.delegate.started), 1)
        self.assertTrue(second_ws.closed)
        self.assertEqual(second.state, ConnectionState.CLOSED)
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))

    async def test_duplicate_survives_a_new_registry_and_ledger_instance(self):
        first, first_task, first_ws = await self.connect()
        await first_ws.feed_json(turn_start())
        await self.wait_for_event(first_ws, "turn.accepted")
        await first_ws.disconnect()
        await asyncio.wait_for(first_task, 1)
        self.ledger.close()

        replacement_ledger = TurnLedger(self.state_root)
        replacement_registry = ConnectionRegistry(replacement_ledger)
        self.ledger = replacement_ledger
        self.registry = replacement_registry
        _, _, second_ws = await self.connect(registry=replacement_registry)
        await second_ws.feed_json(turn_start())
        duplicate = await self.wait_for_event(second_ws, "turn.duplicate")

        self.assertEqual(duplicate["payload"], {"status": "cancelled"})
        self.assertEqual(len(self.delegate.started), 1)

    async def test_turn_id_reuse_under_another_conversation_is_protocol_error(self):
        first, _, first_ws = await self.connect()
        await first_ws.feed_json(turn_start())
        await self.wait_for_event(first_ws, "turn.accepted")
        await first_ws.disconnect()

        _, second_task, second_ws = await self.connect(
            conversation_id=OTHER_CONVERSATION_ID
        )
        await second_ws.feed_json(turn_start(conversation_id=OTHER_CONVERSATION_ID))
        await asyncio.wait_for(second_task, 1)

        self.assertTrue(second_ws.closed)
        self.assertEqual(len(self.delegate.started), 1)

    async def test_disconnect_after_acceptance_cancels_and_marks_terminal(self):
        _, task, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await websocket.disconnect()
        await asyncio.wait_for(task, 1)

        self.assertEqual(len(self.delegate.cancelled), 1)
        self.assertEqual(self.ledger.get(TURN_ID).status, "cancelled")

    async def test_terminal_event_closes_and_releases_conversation_claim(self):
        connection, task, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await connection.mark_terminal(
            "turn.completed",
            {"sessionId": "session"},
        )
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertEqual(connection.state, ConnectionState.CLOSED)
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))

    async def test_disconnect_during_terminal_send_preserves_terminal_status(self):
        connection, run_task, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        send_started = asyncio.Event()
        allow_send = asyncio.Event()
        original_send = websocket.send_str

        async def block_terminal_send(raw):
            if json.loads(raw)["type"] == "turn.completed":
                send_started.set()
                await allow_send.wait()
            await original_send(raw)

        websocket.send_str = block_terminal_send
        terminal_task = asyncio.create_task(
            connection.mark_terminal(
                "turn.completed",
                {"sessionId": "session"},
            )
        )
        await asyncio.wait_for(send_started.wait(), 1)
        await connection.close()
        allow_send.set()
        with self.assertRaises(ConnectionError):
            await terminal_task
        await asyncio.wait_for(run_task, 1)

        self.assertEqual(self.delegate.cancelled, [])
        self.assertEqual(self.ledger.get(TURN_ID).status, "completed")
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))

    async def test_cancel_exception_still_marks_terminal_and_releases_claim(self):
        delegate = FailingCancelDelegate()
        _, task, websocket = await self.connect(delegate=delegate)
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await websocket.disconnect()
        await asyncio.wait_for(task, 1)

        self.assertEqual(len(delegate.cancelled), 1)
        self.assertEqual(self.ledger.get(TURN_ID).status, "cancelled")
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))

    async def test_disconnect_before_acceptance_aborts_upload_without_cancel(self):
        _, task, websocket = await self.connect()
        await websocket.feed_json(upload_begin())
        await self.wait_for_event(websocket, "attachment.upload.accepted")
        self.assertEqual(len(list(self.temp_root.iterdir())), 1)
        await websocket.disconnect()
        await asyncio.wait_for(task, 1)

        self.assertEqual(self.delegate.cancelled, [])
        self.assertEqual(list(self.temp_root.iterdir()), [])

    async def test_upload_exception_explicitly_aborts_transfer(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(upload_begin())
        await self.wait_for_event(websocket, "attachment.upload.accepted")
        attachment_id = UUID(ATTACHMENT_ID)
        transfer = connection._active_uploads[attachment_id]
        abort_calls = 0
        real_abort = transfer.abort

        def record_abort():
            nonlocal abort_calls
            abort_calls += 1
            real_abort()

        def fail_without_cleanup(_chunk):
            raise RuntimeError("lower layer failed before cleanup")

        transfer.abort = record_abort
        transfer.append = fail_without_cleanup
        await websocket.feed_binary(
            encode_binary_frame(
                BinaryChunk(
                    BinaryDirection.UPLOAD,
                    attachment_id,
                    0,
                    True,
                    b"hello",
                )
            )
        )
        await self.wait_for_event(websocket, "attachment.upload.rejected")

        self.assertEqual(abort_calls, 1)
        self.assertNotIn(attachment_id, connection._active_uploads)
        self.assertEqual(list(self.temp_root.iterdir()), [])

    async def test_approval_clarification_and_cancel_are_routed(self):
        _, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await websocket.feed_json(
            {
                "type": "approval.resolve",
                "version": 1,
                "turnId": TURN_ID,
                "requestId": REQUEST_ID,
                "decision": "once",
            }
        )
        await websocket.feed_json(
            {
                "type": "clarification.resolve",
                "version": 1,
                "turnId": TURN_ID,
                "requestId": REQUEST_ID,
                "response": "Use quarterly totals.",
            }
        )
        await websocket.feed_json(
            {"type": "turn.cancel", "version": 1, "turnId": TURN_ID}
        )
        await self.wait_for_event(websocket, "turn.cancelled")

        self.assertEqual(self.delegate.approvals[0][1:], (REQUEST_ID, "once"))
        self.assertEqual(
            self.delegate.clarifications[0][1:],
            (REQUEST_ID, "Use quarterly totals."),
        )
        self.assertEqual(len(self.delegate.cancelled), 1)

    async def test_client_cancel_exception_still_emits_one_terminal(self):
        delegate = FailingCancelDelegate()
        _, task, websocket = await self.connect(delegate=delegate)
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await websocket.feed_json(
            {"type": "turn.cancel", "version": 1, "turnId": TURN_ID}
        )
        terminal = await self.wait_for_event(websocket, "turn.cancelled")
        await asyncio.wait_for(task, 1)

        self.assertEqual(terminal["payload"], {})
        self.assertEqual(
            [
                event["type"]
                for event in websocket.sent_text
                if event["type"] == "turn.cancelled"
            ],
            ["turn.cancelled"],
        )
        self.assertEqual(len(delegate.cancelled), 1)
        self.assertEqual(self.ledger.get(TURN_ID).status, "cancelled")

    async def test_completion_during_disconnect_cancel_is_not_downgraded(self):
        delegate = BlockingCancelDelegate()
        connection, run_task, websocket = await self.connect(delegate=delegate)
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await websocket.disconnect()
        await asyncio.wait_for(delegate.cancel_started.wait(), 1)

        completion_task = asyncio.create_task(
            connection.mark_terminal(
                "turn.completed",
                {"sessionId": "session"},
            )
        )

        async def completion_persisted():
            while self.ledger.get(TURN_ID).status != "completed":
                await asyncio.sleep(0)

        await asyncio.wait_for(completion_persisted(), 1)
        delegate.allow_cancel.set()
        await asyncio.wait_for(run_task, 1)
        await asyncio.gather(completion_task, return_exceptions=True)

        self.assertEqual(len(delegate.cancelled), 1)
        self.assertEqual(self.ledger.get(TURN_ID).status, "completed")
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))

    async def test_nonterminal_events_are_rejected_after_terminal_transition(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        connection.state = ConnectionState.TERMINAL

        for event_type in (
            "assistant.delta",
            "tool.progress",
            "approval.requested",
            "clarification.requested",
        ):
            with self.subTest(event_type=event_type):
                with self.assertRaises(ValueError):
                    await connection.send_event(event_type, {"late": True})

    async def test_queued_threadsafe_event_cannot_cross_terminal_boundary(self):
        connection, run_task, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await connection._send_lock.acquire()
        worker = threading.Thread(
            target=connection.send_event_threadsafe,
            args=("tool.progress", {"label": "late"}),
        )
        worker.start()
        worker.join()
        await asyncio.sleep(0)
        terminal_task = asyncio.create_task(
            connection.mark_terminal(
                "turn.completed",
                {"sessionId": "session"},
            )
        )

        async def terminal_started():
            while connection.state is ConnectionState.ACCEPTED:
                await asyncio.sleep(0)

        await asyncio.wait_for(terminal_started(), 1)
        connection._send_lock.release()
        await asyncio.wait_for(terminal_task, 1)
        await asyncio.wait_for(run_task, 1)

        event_types = [event["type"] for event in websocket.sent_text]
        self.assertNotIn("tool.progress", event_types)
        self.assertEqual(event_types.count("turn.completed"), 1)

    async def test_matching_heartbeat_echo_prevents_timeout(self):
        _, _, websocket = await self.connect(
            heartbeat_interval=0.01,
            heartbeat_timeout=0.04,
        )
        heartbeat = await self.wait_for_event(websocket, "heartbeat")
        await websocket.feed_json(
            {"type": "heartbeat", "version": 1, "nonce": heartbeat["nonce"]}
        )
        await asyncio.sleep(0.045)

        self.assertFalse(websocket.closed)

    async def test_missing_heartbeat_echo_closes_connection(self):
        _, task, websocket = await self.connect(
            heartbeat_interval=0.01,
            heartbeat_timeout=0.025,
        )
        await self.wait_for_event(websocket, "heartbeat")
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)

    async def test_preturn_timeout_releases_conversation_claim(self):
        connection, task, websocket = await self.connect(preturn_timeout=0.02)
        await asyncio.wait_for(task, 1)

        self.assertTrue(websocket.closed)
        self.assertIsNone(await self.registry.get(CONVERSATION_ID))
        self.assertEqual(connection.state, ConnectionState.CLOSED)

    async def test_accepted_turn_cancels_preturn_timeout(self):
        _, _, websocket = await self.connect(preturn_timeout=0.02)
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        await asyncio.sleep(0.03)

        self.assertFalse(websocket.closed)

    async def test_threadsafe_events_are_scheduled_on_the_connection_loop(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")

        worker = threading.Thread(
            target=connection.send_event_threadsafe,
            args=("tool.progress", {"label": "Working"}),
        )
        worker.start()
        worker.join()
        event = await self.wait_for_event(websocket, "tool.progress")

        self.assertEqual(event["payload"], {"label": "Working"})

    async def test_send_attachment_consumes_validated_descriptor(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "outbound.txt"
        path.write_bytes(b"outbound")
        metadata = {
            "id": ATTACHMENT_ID,
            "name": "outbound.txt",
            "mime": "text/plain",
            "kind": "document",
            "sizeBytes": 8,
            "sha256": hashlib.sha256(b"outbound").hexdigest(),
        }

        original_open = Path.open

        def reject_path_reopen(*_args, **_kwargs):
            raise AssertionError("validated outbound file was reopened by pathname")

        Path.open = reject_path_reopen
        try:
            await connection.send_attachment(path, metadata)
        finally:
            Path.open = original_open

        event_types = [event["type"] for event in websocket.sent_text]
        self.assertIn("attachment.download.begin", event_types)
        self.assertIn("attachment.download.completed", event_types)
        self.assertEqual(len(websocket.sent_bytes), 1)

    async def test_send_attachment_allows_exactly_five_unique_ids(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "outbound.txt"
        path.write_bytes(b"outbound")

        for index in range(5):
            await connection.send_attachment(
                path,
                self.outbound_metadata(UUID(int=index + 1)),
            )
        with self.assertRaises(ValueError):
            await connection.send_attachment(
                path,
                self.outbound_metadata(UUID(int=6)),
            )

        begin_events = [
            event
            for event in websocket.sent_text
            if event["type"] == "attachment.download.begin"
        ]
        self.assertEqual(len(begin_events), 5)

    async def test_send_attachment_rejects_duplicate_reserved_id(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "outbound.txt"
        path.write_bytes(b"outbound")
        metadata = self.outbound_metadata(ATTACHMENT_ID)

        await connection.send_attachment(path, metadata)
        with self.assertRaises(ValueError):
            await connection.send_attachment(path, metadata)

        begin_events = [
            event
            for event in websocket.sent_text
            if event["type"] == "attachment.download.begin"
        ]
        self.assertEqual(len(begin_events), 1)

    async def test_send_attachment_reservations_are_atomic(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "outbound.txt"
        path.write_bytes(b"outbound")
        await connection._send_lock.acquire()
        tasks = [
            asyncio.create_task(
                connection.send_attachment(
                    path,
                    self.outbound_metadata(UUID(int=index + 1)),
                )
            )
            for index in range(6)
        ]
        try:
            await asyncio.sleep(0)
        finally:
            connection._send_lock.release()
        results = await asyncio.gather(*tasks, return_exceptions=True)

        self.assertEqual(results.count(None), 5)
        self.assertEqual(
            sum(isinstance(result, ValueError) for result in results),
            1,
        )
        self.assertEqual(
            sum(
                event["type"] == "attachment.download.begin"
                for event in websocket.sent_text
            ),
            5,
        )

    async def test_failed_outbound_reservations_remain_consumed(self):
        outbound_root = self.root / "outbound"
        outbound_root.mkdir()
        connection, _, websocket = await self.connect(
            outbound_roots=[outbound_root]
        )
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        invalid_path = self.root / "outside.txt"
        invalid_path.write_bytes(b"outside")
        valid_path = outbound_root / "valid.txt"
        valid_path.write_bytes(b"valid")

        for index in range(5):
            with self.assertRaises(ValueError):
                await connection.send_attachment(
                    invalid_path,
                    self.outbound_metadata(UUID(int=index + 1)),
                )
        with self.assertRaises(ValueError):
            await connection.send_attachment(
                valid_path,
                self.outbound_metadata(UUID(int=6)),
            )
        with self.assertRaises(ValueError):
            await connection.send_attachment(
                valid_path,
                self.outbound_metadata(UUID(int=1)),
            )

        self.assertNotIn(
            "attachment.download.begin",
            [event["type"] for event in websocket.sent_text],
        )

    async def test_send_attachment_rejects_path_outside_configured_root(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        outside_root = self.root / "outside"
        outside_root.mkdir()
        path = outside_root / "secret.txt"
        path.write_bytes(b"secret")

        with self.assertRaises(ValueError):
            await connection.send_attachment(
                path,
                {"id": ATTACHMENT_ID, "name": "secret.txt"},
            )

        self.assertEqual(websocket.sent_bytes, [])
        self.assertNotIn(
            "attachment.download.begin",
            [event["type"] for event in websocket.sent_text],
        )

    async def test_send_attachment_derives_allowlisted_metadata(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "actual.txt"
        path.write_bytes(b"actual bytes")
        actual_digest = hashlib.sha256(b"actual bytes").hexdigest()

        await connection.send_attachment(
            path,
            {
                "id": ATTACHMENT_ID,
                "name": "../../spoof.png",
                "mime": "image/png",
                "kind": "image",
                "sizeBytes": 999,
                "sha256": "0" * 64,
                "path": "/private/secret",
                "unknown": "discard me",
            },
        )

        begin = next(
            event
            for event in websocket.sent_text
            if event["type"] == "attachment.download.begin"
        )
        self.assertEqual(
            begin["payload"]["attachment"],
            {
                "id": ATTACHMENT_ID,
                "name": "actual.txt",
                "mime": "text/plain",
                "kind": "document",
                "sizeBytes": 12,
                "sha256": actual_digest,
            },
        )
        self.assertNotIn("/private/secret", json.dumps(begin))
        self.assertNotIn("unknown", begin["payload"]["attachment"])

    async def test_send_attachment_streams_the_validated_inode_after_swap(self):
        connection, _, websocket = await self.connect()
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = self.temp_root / "report.txt"
        original = b"trusted original"
        replacement = b"replacement"
        path.write_bytes(original)
        moved = self.temp_root / "moved.txt"
        real_send = websocket.send_str
        swapped = False

        async def swap_after_begin(raw):
            nonlocal swapped
            event = json.loads(raw)
            if event["type"] == "attachment.download.begin" and not swapped:
                swapped = True
                path.rename(moved)
                path.write_bytes(replacement)
            await real_send(raw)

        websocket.send_str = swap_after_begin
        await connection.send_attachment(
            path,
            {
                "id": ATTACHMENT_ID,
                "name": "spoofed.txt",
                "sizeBytes": len(replacement),
                "sha256": hashlib.sha256(replacement).hexdigest(),
            },
        )

        frames = [decode_binary_frame(raw) for raw in websocket.sent_bytes]
        self.assertEqual(b"".join(frame.payload for frame in frames), original)
        begin = next(
            event
            for event in websocket.sent_text
            if event["type"] == "attachment.download.begin"
        )
        self.assertEqual(
            begin["payload"]["attachment"]["sha256"],
            hashlib.sha256(original).hexdigest(),
        )

    async def test_outbound_snapshot_survives_in_place_mutation_before_send(self):
        outbound_root = self.root / "outbound"
        outbound_root.mkdir()
        connection, _, websocket = await self.connect(
            outbound_roots=[outbound_root]
        )
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        original = b"trusted original bytes"

        def overwrite(path):
            path.write_bytes(b"x" * len(original))

        def truncate(path):
            os.truncate(path, 3)

        def grow(path):
            with open(path, "ab") as handle:
                handle.write(b" untrusted growth")

        for index, (name, mutate) in enumerate(
            (
                ("overwrite", overwrite),
                ("truncate", truncate),
                ("growth", grow),
            ),
            start=1,
        ):
            with self.subTest(mutation=name):
                path = outbound_root / f"{name}.txt"
                path.write_bytes(original)
                attachment_id = UUID(int=index)
                frame_start = len(websocket.sent_bytes)
                text_start = len(websocket.sent_text)
                await connection._send_lock.acquire()
                task = asyncio.create_task(
                    connection.send_attachment(
                        path,
                        self.outbound_metadata(attachment_id),
                    )
                )
                await asyncio.sleep(0)
                mutate(path)
                connection._send_lock.release()
                await task

                emitted = websocket.sent_text[text_start:]
                begin = next(
                    event
                    for event in emitted
                    if event["type"] == "attachment.download.begin"
                )
                frames = [
                    decode_binary_frame(raw)
                    for raw in websocket.sent_bytes[frame_start:]
                ]
                payload = b"".join(frame.payload for frame in frames)
                self.assertEqual(payload, original)
                self.assertEqual(
                    begin["payload"]["attachment"]["sizeBytes"],
                    len(original),
                )
                self.assertEqual(
                    begin["payload"]["attachment"]["sha256"],
                    hashlib.sha256(original).hexdigest(),
                )

    async def test_snapshot_metadata_and_frames_share_sniffed_bytes(self):
        outbound_root = self.root / "outbound"
        outbound_root.mkdir()
        connection, _, websocket = await self.connect(
            outbound_roots=[outbound_root]
        )
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        original = b"\x89PNG\r\n\x1a\n" + b"snapshot image bytes"
        path = outbound_root / "image.png"
        path.write_bytes(original)
        await connection._send_lock.acquire()
        task = asyncio.create_task(
            connection.send_attachment(
                path,
                self.outbound_metadata(ATTACHMENT_ID),
            )
        )
        await asyncio.sleep(0)
        path.write_bytes(b"plain text".ljust(len(original), b" "))
        connection._send_lock.release()
        await task

        begin = next(
            event
            for event in websocket.sent_text
            if event["type"] == "attachment.download.begin"
        )
        attachment = begin["payload"]["attachment"]
        payload = b"".join(
            decode_binary_frame(raw).payload
            for raw in websocket.sent_bytes
        )
        self.assertEqual(payload, original)
        self.assertEqual(attachment["mime"], "image/png")
        self.assertEqual(attachment["sizeBytes"], len(payload))
        self.assertEqual(
            attachment["sha256"],
            hashlib.sha256(payload).hexdigest(),
        )

    async def test_snapshot_rejects_source_growth_beyond_ten_mib(self):
        outbound_root = self.root / "outbound"
        outbound_root.mkdir()
        connection, _, websocket = await self.connect(
            outbound_roots=[outbound_root]
        )
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")
        path = outbound_root / "growing.txt"
        path.write_bytes(b"a" * MAX_FILE_BYTES)
        real_read = os.read
        grew = False

        def grow_after_first_read(descriptor, count):
            nonlocal grew
            chunk = real_read(descriptor, count)
            if chunk and not grew:
                grew = True
                self.assertEqual(list(self.temp_root.iterdir()), [])
                with open(path, "ab") as handle:
                    handle.write(b"x")
            return chunk

        with mock.patch(
            "bearcode_transport.transfers.os.read",
            side_effect=grow_after_first_read,
        ):
            with self.assertRaises(ValueError):
                await connection.send_attachment(
                    path,
                    self.outbound_metadata(ATTACHMENT_ID),
                )

        self.assertTrue(grew)
        self.assertEqual(list(self.temp_root.iterdir()), [])
        self.assertNotIn(
            "attachment.download.begin",
            [event["type"] for event in websocket.sent_text],
        )

    async def test_snapshot_cleanup_on_success_cancellation_and_error(self):
        outbound_root = self.root / "outbound"
        outbound_root.mkdir()
        connection, _, websocket = await self.connect(
            outbound_roots=[outbound_root]
        )
        await websocket.feed_json(turn_start())
        await self.wait_for_event(websocket, "turn.accepted")

        def descriptor_count():
            return len(os.listdir("/dev/fd"))

        success_path = outbound_root / "success.txt"
        success_path.write_bytes(b"success")
        before_success = descriptor_count()
        await connection.send_attachment(
            success_path,
            self.outbound_metadata(UUID(int=1)),
        )
        self.assertEqual(descriptor_count(), before_success)
        self.assertEqual(list(self.temp_root.iterdir()), [])

        cancel_path = outbound_root / "cancel.txt"
        cancel_path.write_bytes(b"cancel")
        before_cancel = descriptor_count()
        await connection._send_lock.acquire()
        cancel_task = asyncio.create_task(
            connection.send_attachment(
                cancel_path,
                self.outbound_metadata(UUID(int=2)),
            )
        )
        await asyncio.sleep(0)
        cancel_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancel_task
        connection._send_lock.release()
        self.assertEqual(descriptor_count(), before_cancel)
        self.assertEqual(list(self.temp_root.iterdir()), [])

        error_path = outbound_root / "error.txt"
        error_path.write_bytes(b"error")
        real_send = websocket.send_str

        async def fail_download_begin(raw):
            event = json.loads(raw)
            if event["type"] == "attachment.download.begin":
                raise RuntimeError("send failed")
            await real_send(raw)

        websocket.send_str = fail_download_begin
        before_error = descriptor_count()
        with self.assertRaises(RuntimeError):
            await connection.send_attachment(
                error_path,
                self.outbound_metadata(UUID(int=3)),
            )
        self.assertEqual(descriptor_count(), before_error)
        self.assertEqual(list(self.temp_root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
