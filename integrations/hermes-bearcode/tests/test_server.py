import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp import WSServerHandshakeError, WSMsgType
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parents[1]))

from bearcode_transport.server import BearCodeServer


CONVERSATION_ID = "11111111-1111-4111-8111-111111111111"
OTHER_CONVERSATION_ID = "12111111-1111-4111-8111-111111111111"


def hello(conversation_id=CONVERSATION_ID, versions=None):
    return {
        "type": "hello",
        "protocol": "bearcode-hermes",
        "versions": [1] if versions is None else versions,
        "client": {"name": "BearCode", "version": "1.0.0"},
        "conversationId": conversation_id,
        "installationId": "22222222-2222-4222-8222-222222222222",
    }


class FakeDelegate:
    def __init__(self):
        self.cancelled = []

    async def start_turn(self, connection, event, uploads):
        pass

    async def cancel_turn(self, connection):
        self.cancelled.append(connection)

    async def resolve_approval(self, connection, request_id, decision):
        return True

    async def resolve_clarification(self, connection, request_id, response):
        return True


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.server = BearCodeServer(
            host="127.0.0.1",
            port=0,
            platform_key="platform-secret",
            delegate=FakeDelegate(),
            temp_root=root / "temp",
            state_root=root / "state",
        )
        self.test_server = TestServer(self.server.create_application())
        self.client = TestClient(self.test_server)
        await self.client.start_server()
        self.websockets = []

    async def asyncTearDown(self):
        for websocket in reversed(self.websockets):
            if not websocket.closed:
                await websocket.close()
        await self.client.close()
        self.server.ledger.close()
        self.directory.cleanup()

    async def websocket(self, authorization="Bearer platform-secret"):
        headers = {}
        if authorization is not None:
            headers["Authorization"] = authorization
        websocket = await self.client.ws_connect(
            "/v1/bearcode",
            headers=headers,
        )
        self.websockets.append(websocket)
        return websocket

    async def test_missing_and_incorrect_bearer_fail_before_upgrade(self):
        for authorization in (None, "Bearer incorrect"):
            with self.subTest(authorization=authorization):
                with self.assertRaises(WSServerHandshakeError) as raised:
                    await self.websocket(authorization)
                self.assertEqual(raised.exception.status, 401)

    async def test_sixth_failed_authentication_is_rate_limited(self):
        for _ in range(5):
            with self.assertRaises(WSServerHandshakeError) as raised:
                await self.websocket("Bearer incorrect")
            self.assertEqual(raised.exception.status, 401)

        with self.assertRaises(WSServerHandshakeError) as raised:
            await self.websocket("Bearer incorrect")
        self.assertEqual(raised.exception.status, 429)

    async def test_correct_bearer_accepts_websocket(self):
        websocket = await self.websocket()
        self.assertFalse(websocket.closed)

    async def test_first_frame_must_be_hello(self):
        websocket = await self.websocket()
        await websocket.send_json(
            {"type": "heartbeat", "version": 1, "nonce": "too-early"}
        )
        message = await websocket.receive(timeout=1)

        self.assertIn(message.type, {WSMsgType.CLOSE, WSMsgType.CLOSING})

    async def test_incompatible_version_receives_rejection_then_closes(self):
        websocket = await self.websocket()
        await websocket.send_json(hello(versions=[2]))
        message = await websocket.receive_json(timeout=1)

        self.assertEqual(
            message,
            {
                "type": "hello.rejected",
                "protocol": "bearcode-hermes",
                "supportedVersions": [1],
                "error": {
                    "code": "protocol.unsupported_version",
                    "message": "No mutually supported protocol version.",
                    "retryable": False,
                },
            },
        )
        close = await websocket.receive(timeout=1)
        self.assertIn(close.type, {WSMsgType.CLOSE, WSMsgType.CLOSING})

    async def test_accepted_capabilities_match_protocol_fixture(self):
        fixture_path = (
            Path(__file__).parents[1] / "fixtures/protocol-v1/hello.json"
        )
        expected = json.loads(fixture_path.read_text())["accepted"]
        websocket = await self.websocket()
        await websocket.send_json(hello())
        accepted = await websocket.receive_json(timeout=1)

        accepted["connectionId"] = expected["connectionId"]
        self.assertEqual(accepted, expected)

    async def test_same_conversation_is_busy_but_different_can_connect(self):
        first = await self.websocket()
        await first.send_json(hello())
        self.assertEqual(
            (await first.receive_json(timeout=1))["type"],
            "hello.accepted",
        )

        duplicate = await self.websocket()
        await duplicate.send_json(hello())
        rejected = await duplicate.receive_json(timeout=1)
        self.assertEqual(rejected["type"], "hello.rejected")
        self.assertEqual(rejected["error"]["code"], "plugin.conversation_busy")

        other = await self.websocket()
        await other.send_json(hello(OTHER_CONVERSATION_ID))
        self.assertEqual(
            (await other.receive_json(timeout=1))["type"],
            "hello.accepted",
        )

    async def test_only_get_route_is_registered(self):
        response = await self.client.post("/v1/bearcode")
        self.assertEqual(response.status, 405)
        head = await self.client.head("/v1/bearcode")
        self.assertEqual(head.status, 405)


class ServerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_and_stop_close_active_websockets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = BearCodeServer(
                host="127.0.0.1",
                port=0,
                platform_key="platform-secret",
                delegate=FakeDelegate(),
                temp_root=root / "temp",
                state_root=root / "state",
            )
            await server.start()
            socket = server.site._server.sockets[0]
            port = socket.getsockname()[1]

            from aiohttp import ClientSession

            async with ClientSession() as session:
                websocket = await session.ws_connect(
                    f"http://127.0.0.1:{port}/v1/bearcode",
                    headers={"Authorization": "Bearer platform-secret"},
                )
                await websocket.send_json(hello())
                self.assertEqual(
                    (await websocket.receive_json(timeout=1))["type"],
                    "hello.accepted",
                )
                await server.stop()
                message = await websocket.receive(timeout=1)
                self.assertIn(
                    message.type,
                    {
                        WSMsgType.CLOSE,
                        WSMsgType.CLOSED,
                        WSMsgType.CLOSING,
                    },
                )
            server.ledger.close()

    async def test_stop_rejects_connection_arriving_during_listener_shutdown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = BearCodeServer(
                host="127.0.0.1",
                port=0,
                platform_key="platform-secret",
                delegate=FakeDelegate(),
                temp_root=root / "temp",
                state_root=root / "state",
            )
            await server.start()
            socket = server.site._server.sockets[0]
            port = socket.getsockname()[1]
            from aiohttp import ClientSession

            async with ClientSession() as session:
                active = await session.ws_connect(
                    f"http://127.0.0.1:{port}/v1/bearcode",
                    headers={"Authorization": "Bearer platform-secret"},
                )
                await active.send_json(hello())
                await active.receive_json(timeout=1)
                real_site = server.site
                stop_entered = asyncio.Event()
                allow_site_stop = asyncio.Event()

                class DelayedSite:
                    _server = real_site._server

                    async def stop(self):
                        stop_entered.set()
                        await allow_site_stop.wait()
                        await real_site.stop()

                server.site = DelayedSite()
                stop_task = asyncio.create_task(server.stop())
                late = None
                try:
                    await asyncio.wait_for(stop_entered.wait(), 1)
                    with self.assertRaises(WSServerHandshakeError) as raised:
                        late = await session.ws_connect(
                            f"http://127.0.0.1:{port}/v1/bearcode",
                            headers={
                                "Authorization": "Bearer platform-secret"
                            },
                        )
                    self.assertEqual(raised.exception.status, 503)
                finally:
                    if late is not None:
                        await late.close()
                    allow_site_stop.set()
                    if not stop_task.done():
                        await asyncio.wait_for(stop_task, 1)
                    await active.close()
            server.ledger.close()


if __name__ == "__main__":
    unittest.main()
