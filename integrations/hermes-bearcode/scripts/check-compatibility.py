#!/usr/bin/env python3
"""Validate the installed Hermes public plugin contract before deployment."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import ModuleType
from typing import Any


REQUIRED_BASE_METHODS = {
    "connect",
    "disconnect",
    "send",
    "edit_message",
    "send_document",
    "send_image_file",
    "send_clarify",
    "handle_message",
    "build_source",
    "on_processing_start",
    "on_processing_complete",
    "validate_media_delivery_path",
}


class CompatibilityError(RuntimeError):
    """The installed Hermes runtime cannot host this plugin."""


class RecordingContext:
    def __init__(self) -> None:
        self.registrations: list[dict[str, Any]] = []

    def register_platform(self, **registration: Any) -> None:
        self.registrations.append(registration)


def _require_callable(owner: object, name: str, source: str) -> None:
    if not callable(getattr(owner, name, None)):
        raise CompatibilityError(f"{source} is missing required hook {name}")


def _load_adapter(plugin_root: Path) -> ModuleType:
    adapter_path = plugin_root / "adapter.py"
    if not adapter_path.is_file() or adapter_path.is_symlink():
        raise CompatibilityError("staged adapter.py is missing or unsafe")
    if str(plugin_root) not in sys.path:
        sys.path.insert(0, str(plugin_root))
    spec = importlib.util.spec_from_file_location(
        "bearcode_compatibility_adapter",
        adapter_path,
    )
    if spec is None or spec.loader is None:
        raise CompatibilityError("could not load staged adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(plugin_root: Path) -> None:
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        ProcessingOutcome,
        SendResult,
        cache_media_bytes,
    )
    from tools.approval import resolve_gateway_approval
    from tools.clarify_gateway import resolve_gateway_clarify

    for method in sorted(REQUIRED_BASE_METHODS):
        _require_callable(
            BasePlatformAdapter,
            method,
            "BasePlatformAdapter",
        )
    for value, name in (
        (MessageEvent, "MessageEvent"),
        (MessageType, "MessageType"),
        (ProcessingOutcome, "ProcessingOutcome"),
        (SendResult, "SendResult"),
        (cache_media_bytes, "cache_media_bytes"),
        (resolve_gateway_approval, "resolve_gateway_approval"),
        (resolve_gateway_clarify, "resolve_gateway_clarify"),
    ):
        if value is None or (
            name
            in {
                "cache_media_bytes",
                "resolve_gateway_approval",
                "resolve_gateway_clarify",
            }
            and not callable(value)
        ):
            raise CompatibilityError(
                f"Hermes is missing required public symbol {name}"
            )

    adapter = _load_adapter(plugin_root)
    _require_callable(adapter, "register", "adapter.py")
    context = RecordingContext()
    adapter.register(context)
    if len(context.registrations) != 1:
        raise CompatibilityError(
            "adapter.py must register exactly one platform"
        )
    if context.registrations[0].get("name") != "bearcode":
        raise CompatibilityError(
            "adapter.py did not register the bearcode platform"
        )


def main() -> int:
    plugin_root = Path(__file__).resolve().parents[1]
    try:
        check(plugin_root)
    except Exception as error:
        print(
            f"Hermes BearCode compatibility check failed: {error}",
            file=sys.stderr,
        )
        return 1
    print("Hermes runtime is compatible with the BearCode platform plugin.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
