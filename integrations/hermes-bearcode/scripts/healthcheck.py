#!/usr/bin/env python3
"""Probe the authenticated BearCode WebSocket without starting a turn."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import shlex
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
EXPECTED_CAPABILITIES = {
    "streaming": True,
    "toolProgress": True,
    "approvals": True,
    "clarifications": True,
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


def _parse_literal(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    if raw[0] in {"'", '"'}:
        try:
            values = shlex.split(raw, comments=False, posix=True)
        except ValueError as error:
            raise HealthcheckError("invalid quoted environment value") from error
        if len(values) != 1:
            raise HealthcheckError("invalid quoted environment value")
        return values[0]
    return raw


def _read_unique_env_value(path: Path, name: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise HealthcheckError("could not read environment file") from error
    matches = []
    for line in text.splitlines():
        candidate = line.lstrip()
        if candidate.startswith("export "):
            candidate = candidate[7:].lstrip()
        if "=" not in candidate:
            continue
        key, raw = candidate.split("=", 1)
        if key == name:
            matches.append(_parse_literal(raw))
    if len(matches) != 1 or not matches[0]:
        raise HealthcheckError(
            f"environment file must contain one non-empty {name}"
        )
    return matches[0]


def _platform_key() -> str:
    if "BEARCODE_PLATFORM_KEY" in os.environ:
        key = os.environ["BEARCODE_PLATFORM_KEY"]
        if not key:
            raise HealthcheckError("BEARCODE_PLATFORM_KEY is required")
        return key
    env_file = os.environ.get("BEARCODE_ENV_FILE", "").strip()
    if not env_file:
        raise HealthcheckError("BEARCODE_PLATFORM_KEY is required")
    return _read_unique_env_value(Path(env_file), "BEARCODE_PLATFORM_KEY")


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
        or type(message.get("version")) is not int
        or message.get("version") != PROTOCOL_VERSION
    ):
        raise HealthcheckError("incompatible protocol handshake")
    capabilities = message.get("capabilities")
    if not isinstance(capabilities, dict):
        raise HealthcheckError("incompatible capability response")
    for name, expected in EXPECTED_CAPABILITIES.items():
        if capabilities.get(name) is not expected:
            raise HealthcheckError(f"incompatible capability {name}")
    attachments = capabilities.get("attachments")
    if not isinstance(attachments, dict):
        raise HealthcheckError("incompatible attachment capabilities")
    for name, expected in EXPECTED_ATTACHMENTS.items():
        actual = attachments.get(name)
        if isinstance(expected, bool):
            compatible = actual is expected
        else:
            compatible = type(actual) is int and actual == expected
        if not compatible:
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
        key = _platform_key()
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
