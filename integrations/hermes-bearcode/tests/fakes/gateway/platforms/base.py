"""Minimal installed Hermes platform-adapter contract."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from gateway.session import SessionSource


IMAGE_CACHE_DIR = Path("/tmp/hermes-fake-cache/images")
AUDIO_CACHE_DIR = Path("/tmp/hermes-fake-cache/audio")
VIDEO_CACHE_DIR = Path("/tmp/hermes-fake-cache/videos")
DOCUMENT_CACHE_DIR = Path("/tmp/hermes-fake-cache/documents")


def _cache_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_image_cache_dir():
    return _cache_dir(IMAGE_CACHE_DIR)


def get_audio_cache_dir():
    return _cache_dir(AUDIO_CACHE_DIR)


def get_video_cache_dir():
    return _cache_dir(VIDEO_CACHE_DIR)


def get_document_cache_dir():
    return _cache_dir(DOCUMENT_CACHE_DIR)


@dataclass(frozen=True)
class CachedMedia:
    path: str
    media_type: str
    kind: str
    display_name: str


def cache_media_bytes(
    data: bytes,
    *,
    filename: str = "",
    mime_type: str = "",
    default_kind: Optional[str] = None,
):
    kind = (
        "image"
        if mime_type.startswith("image/") or default_kind == "image"
        else "document"
    )
    root = get_image_cache_dir() if kind == "image" else get_document_cache_dir()
    safe_name = Path(filename).name or "file"
    path = root / f"{uuid4().hex}_{safe_name}"
    path.write_bytes(data)
    media_type = mime_type or (
        "image/jpeg" if kind == "image" else "application/octet-stream"
    )
    return CachedMedia(str(path), media_type, kind, safe_name)


class MessageType(Enum):
    TEXT = "text"
    PHOTO = "photo"
    DOCUMENT = "document"


class ProcessingOutcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT
    source: SessionSource = None
    raw_message: Any = None
    message_id: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False


class BasePlatformAdapter(ABC):
    supports_status_text = False
    REQUIRES_EDIT_FINALIZE = False

    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._running = False
        self.handled_messages = []
        self.cancelled_sessions = []

    @property
    def name(self):
        return self.platform.value

    def _mark_connected(self):
        self._running = True

    def _mark_disconnected(self):
        self._running = False

    async def handle_message(self, event):
        self.handled_messages.append(event)

    async def cancel_session_processing(
        self,
        session_key,
        *,
        release_guard=True,
        discard_pending=True,
    ):
        self.cancelled_sessions.append(
            (session_key, release_guard, discard_pending)
        )

    def build_source(
        self,
        chat_id,
        chat_name=None,
        chat_type="dm",
        user_id=None,
        user_name=None,
        thread_id=None,
        message_id=None,
        role_authorized=False,
        **kwargs,
    ):
        del kwargs
        return SessionSource(
            platform=self.platform,
            chat_id=str(chat_id),
            chat_name=chat_name,
            chat_type=chat_type,
            user_id=str(user_id) if user_id else None,
            user_name=user_name,
            thread_id=str(thread_id) if thread_id else None,
            message_id=str(message_id) if message_id else None,
            role_authorized=role_authorized,
        )

    @staticmethod
    def validate_media_delivery_path(path):
        if not path:
            return None
        try:
            resolved = Path(path).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return None
        if not resolved.is_file():
            return None
        return str(resolved)

    @abstractmethod
    async def connect(self, *, is_reconnect=False):
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self):
        raise NotImplementedError

    @abstractmethod
    async def send(self, chat_id, content, reply_to=None, metadata=None):
        raise NotImplementedError

    @abstractmethod
    async def get_chat_info(self, chat_id):
        raise NotImplementedError
