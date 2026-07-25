#!/usr/bin/env python3
"""Probe the authenticated BearCode WebSocket without starting a turn."""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Any
from uuid import uuid4

import aiohttp


PROTOCOL_NAME = "bearcode-hermes"
PROTOCOL_VERSION = 1
EXPECTED_ATTACHMENTS = {
    "upload": True,
    "download": True,
    "maxFiles": 5,
    "maxBytesPerFile": 10 * 1024 * 1024,
    "maxChunkBytes": 256 * 1024,
}
CONNECT_TIMEOUT_SECONDS = 10
MESSAGE_TIMEOUT_SECONDS = 10


class HealthcheckError(RuntimeError):
    """The live plugin did not satisfy the native protocol contract."""


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise HealthcheckError(f"{name} is required")
    return value


def _canonical_hello() -> dict[str, Any]:
    return {
        "type": "hello",
        "protocol": PROTOCOL_NAME,
        "versions": [PROTOCOL_VERSION],
        "client": {
            "name": "BearCode",
            "version": "1.0.0",
        },
        "conversationId": str(uuid4()),
        "installationId": str(uuid4()),
    }


def _validate_accepted(message: object) -> None:
    if not isinstance(message, dict):
        raise HealthcheckError("incompatible non-object handshake response")
    if (
        message.get("type") != "hello.accepted"
        or message.get("protocol") != PROTOCOL_NAME
        or message.get("version") != PROTOCOL_VERSION
    ):
        raise HealthcheckError("incompatible protocol handshake")
    capabilities = message.get("capabilities")
    if not isinstance(capabilities, dict):
        raise HealthcheckError("incompatible capability response")
    attachments = capabilities.get("attachments")
    if not isinstance(attachments, dict):
        raise HealthcheckError("incompatible attachment capabilities")
    for name, expected in EXPECTED_ATTACHMENTS.items():
        if attachments.get(name) != expected:
            raise HealthcheckError(
                f"incompatible attachment capability {name}"
            )


async def probe(url: str, key: str) -> None:
    timeout = aiohttp.ClientTimeout(total=CONNECT_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.ws_connect(
            url,
            headers={"Authorization": f"Bearer {key}"},
            autoclose=True,
            autoping=True,
        ) as socket:
            await socket.send_json(_canonical_hello())
            try:
                message = await asyncio.wait_for(
                    socket.receive(),
                    timeout=MESSAGE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError as error:
                raise HealthcheckError(
                    "incompatible plugin handshake timeout"
                ) from error
            if message.type is not aiohttp.WSMsgType.TEXT:
                raise HealthcheckError(
                    "incompatible non-text handshake response"
                )
            try:
                payload = message.json()
            except (TypeError, ValueError) as error:
                raise HealthcheckError(
                    "incompatible invalid JSON handshake response"
                ) from error
            _validate_accepted(payload)
            await socket.close()


def main() -> int:
    try:
        url = _required_environment("BEARCODE_NATIVE_URL")
        key = _required_environment("BEARCODE_PLATFORM_KEY")
        asyncio.run(probe(url, key))
    except Exception:
        # Deliberately avoid rendering exceptions: request errors can retain
        # headers, and the platform key must never be reflected to logs.
        print(
            "BearCode health check failed: incompatible, unauthorized, "
            "or unreachable plugin.",
            file=sys.stderr,
        )
        return 1
    print("BearCode health check passed for protocol 1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
