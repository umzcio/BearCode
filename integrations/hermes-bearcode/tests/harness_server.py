"""Deterministic real-transport server for the TypeScript integration test."""
import asyncio
import hashlib
import os
import signal
import sys
import tempfile
import traceback
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from bearcode_transport.server import BearCodeServer


EXPECTED_UPLOAD = b"Hello!"
EXPECTED_UPLOAD_NAME = "fixture.txt"
EXPECTED_UPLOAD_SHA256 = (
    "334d016f755cd6dc58c53a86e183882f8ec14f52fb05345887c8a5edd42c87b7"
)
DOWNLOAD_BYTES = b"%PDF"
DOWNLOAD_ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


@dataclass
class TurnState:
    command: str
    approval_request_id: str = None
    clarification_request_id: str = None
    approval: asyncio.Future = None
    clarification: asyncio.Future = None
    cancelled: asyncio.Event = None
    task: asyncio.Task = None


class DeterministicDelegate:
    def __init__(self, outbound_path):
        self.outbound_path = Path(outbound_path)
        self.states = {}

    async def start_turn(self, connection, event, uploads):
        loop = asyncio.get_running_loop()
        state = TurnState(
            command=event["text"],
            approval=loop.create_future(),
            clarification=loop.create_future(),
            cancelled=asyncio.Event(),
        )
        self.states[connection] = state
        state.task = asyncio.create_task(
            self._run_guarded(connection, state, uploads)
        )
        state.task.add_done_callback(
            lambda completed, active=state, owner=connection: (
                self._task_done(owner, active, completed)
            )
        )

    async def cancel_turn(self, connection):
        state = self.states.get(connection)
        if state is None:
            return
        state.cancelled.set()
        if state.command != "cancel" and not state.task.done():
            state.task.cancel()
        if state.task is not asyncio.current_task():
            await asyncio.gather(state.task, return_exceptions=True)

    async def resolve_approval(self, connection, request_id, decision):
        state = self.states.get(connection)
        if (
            state is None
            or state.command != "approve"
            or request_id != state.approval_request_id
            or state.approval.done()
        ):
            return False
        state.approval.set_result(decision)
        return True

    async def resolve_clarification(
        self,
        connection,
        request_id,
        response,
    ):
        state = self.states.get(connection)
        if (
            state is None
            or state.command != "clarify"
            or request_id != state.clarification_request_id
            or state.clarification.done()
        ):
            return False
        state.clarification.set_result(response)
        return True

    async def shutdown(self):
        states = tuple(self.states.values())
        for state in states:
            state.cancelled.set()
            if state.task is not None and not state.task.done():
                state.task.cancel()
        await asyncio.gather(
            *(state.task for state in states if state.task is not None),
            return_exceptions=True,
        )

    def _task_done(self, connection, state, completed):
        if self.states.get(connection) is state:
            self.states.pop(connection, None)
        if not completed.cancelled():
            completed.exception()

    async def _run_guarded(self, connection, state, uploads):
        try:
            await self._run(connection, state, uploads)
        except asyncio.CancelledError:
            raise
        except BaseException:
            traceback.print_exc(file=sys.stderr)
            await connection.mark_terminal(
                "turn.failed",
                {
                    "error": {
                        "code": "hermes.harness_failure",
                        "message": "The deterministic integration harness failed.",
                        "retryable": False,
                    }
                },
            )

    async def _run(self, connection, state, uploads):
        command = state.command
        if command == "text":
            await self._assistant(connection, ["Hel", "lo"])
            await self._complete(connection)
            return
        if command == "tool":
            tool_call_id = str(uuid4())
            await connection.send_event(
                "tool.started",
                {
                    "toolCallId": tool_call_id,
                    "name": "integration-tool",
                    "label": "Starting integration tool",
                },
            )
            await connection.send_event(
                "tool.completed",
                {
                    "toolCallId": tool_call_id,
                    "status": "completed",
                },
            )
            await self._complete(connection)
            return
        if command == "approve":
            state.approval_request_id = str(uuid4())
            await connection.send_event(
                "approval.requested",
                {
                    "requestId": state.approval_request_id,
                    "toolCallId": str(uuid4()),
                    "command": "printf approved",
                    "description": "Approve the integration command",
                    "allowSession": True,
                    "allowPermanent": False,
                    "smartDenied": False,
                },
            )
            decision = await state.approval
            await self._assistant(connection, [f"approved:{decision}"])
            await self._complete(connection)
            return
        if command == "clarify":
            state.clarification_request_id = str(uuid4())
            await connection.send_event(
                "clarification.requested",
                {
                    "requestId": state.clarification_request_id,
                    "question": "Which path?",
                    "choices": ["alpha", "beta"],
                },
            )
            response = await state.clarification
            await self._assistant(connection, [f"clarified:{response}"])
            await self._complete(connection)
            return
        if command == "upload":
            self._assert_upload(uploads)
            upload = uploads[0]
            await self._assistant(
                connection,
                [
                    (
                        f"upload:{upload.name}:{upload.sha256}:"
                        f"{upload.size_bytes}"
                    )
                ],
            )
            await self._complete(connection)
            return
        if command == "download":
            await connection.send_attachment(
                self.outbound_path,
                {"id": DOWNLOAD_ATTACHMENT_ID},
            )
            await self._complete(connection)
            return
        if command == "cancel":
            await state.cancelled.wait()
            return
        if command == "fail":
            message_id = str(uuid4())
            await connection.send_event(
                "assistant.started",
                {"messageId": message_id},
            )
            await connection.send_event(
                "assistant.delta",
                {"messageId": message_id, "text": "partial"},
            )
            await connection.mark_terminal(
                "turn.failed",
                {
                    "error": {
                        "code": "hermes.integration_failure",
                        "message": "Deterministic integration failure.",
                        "retryable": False,
                    }
                },
            )
            return
        raise ValueError(f"unknown integration command: {command}")

    @staticmethod
    def _assert_upload(uploads):
        if len(uploads) != 1:
            raise AssertionError("expected exactly one verified upload")
        upload = uploads[0]
        if upload.name != EXPECTED_UPLOAD_NAME:
            raise AssertionError("verified upload name changed")
        if upload.size_bytes != len(EXPECTED_UPLOAD):
            raise AssertionError("verified upload size changed")
        if upload.sha256 != EXPECTED_UPLOAD_SHA256:
            raise AssertionError("verified upload digest changed")
        data = os.pread(upload._descriptor, upload.size_bytes, 0)
        if data != EXPECTED_UPLOAD:
            raise AssertionError("verified cached upload bytes changed")
        if hashlib.sha256(data).hexdigest() != EXPECTED_UPLOAD_SHA256:
            raise AssertionError("cached upload digest did not match")

    @staticmethod
    async def _assistant(connection, chunks):
        message_id = str(uuid4())
        await connection.send_event(
            "assistant.started",
            {"messageId": message_id},
        )
        for text in chunks:
            await connection.send_event(
                "assistant.delta",
                {"messageId": message_id, "text": text},
            )
        await connection.send_event(
            "assistant.completed",
            {"messageId": message_id},
        )

    @staticmethod
    async def _complete(connection):
        await connection.mark_terminal(
            "turn.completed",
            {"sessionId": "integration-session"},
        )


def required_environment():
    raw_port = os.environ.get("BEARCODE_TEST_PORT")
    platform_key = os.environ.get("BEARCODE_PLATFORM_KEY")
    if raw_port is None or platform_key is None:
        raise RuntimeError(
            "BEARCODE_TEST_PORT and BEARCODE_PLATFORM_KEY are required"
        )
    port = int(raw_port)
    if port < 1 or port > 65535:
        raise ValueError("BEARCODE_TEST_PORT is outside the TCP port range")
    return port, platform_key


async def run():
    port, platform_key = required_environment()
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop_requested.set)

    with tempfile.TemporaryDirectory(
        prefix="bearcode-native-harness-"
    ) as directory:
        root = Path(directory)
        outbound_root = root / "outbound"
        outbound_root.mkdir(mode=0o700)
        outbound_path = outbound_root / "analysis.pdf"
        outbound_path.write_bytes(DOWNLOAD_BYTES)
        delegate = DeterministicDelegate(outbound_path)
        server = BearCodeServer(
            host="127.0.0.1",
            port=port,
            platform_key=platform_key,
            delegate=delegate,
            temp_root=root / "temp",
            state_root=root / "state",
            outbound_roots=[outbound_root],
        )
        try:
            await server.start()
            sys.stdout.write("READY\n")
            sys.stdout.flush()
            await stop_requested.wait()
        finally:
            try:
                await server.stop()
            finally:
                await delegate.shutdown()
                server.ledger.close()


if __name__ == "__main__":
    asyncio.run(run())
