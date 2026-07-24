import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
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


class TurnLedgerTests(unittest.TestCase):
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
                for index in range(1025):
                    ledger.accept(UUID(int=index + 1), CONVERSATION_ID)
                with sqlite3.connect(ledger.path) as database:
                    count = database.execute(
                        "SELECT COUNT(*) FROM bearcode_turns"
                    ).fetchone()[0]
                self.assertEqual(count, 1024)
            finally:
                ledger.close()


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


if __name__ == "__main__":
    unittest.main()
