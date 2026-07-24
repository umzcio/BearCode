"""Codec and validation helpers for BearCode's Hermes V1 wire protocol."""
import json
import struct
from dataclasses import dataclass
from enum import IntEnum
from uuid import UUID

PROTOCOL_NAME = "bearcode-hermes"
PROTOCOL_VERSION = 1
MAGIC = b"BCH1"
HEADER = struct.Struct(">4sBBBB16sII")
HEADER_BYTES = 32
MAX_CHUNK_BYTES = 256 * 1024
MAX_FILES = 5
MAX_FILE_BYTES = 10 * 1024 * 1024


class BinaryDirection(IntEnum):
    UPLOAD = 1
    DOWNLOAD = 2


@dataclass(frozen=True)
class BinaryChunk:
    direction: BinaryDirection
    attachment_id: UUID
    chunk_index: int
    final: bool
    payload: bytes


class ProtocolViolation(ValueError):
    pass


_CLIENT_KEYS = {
    "attachment.upload.begin": {"type", "version", "turnId", "attachment"},
    "turn.start": {"type", "version", "turnId", "conversationId", "text", "attachmentIds"},
    "approval.resolve": {"type", "version", "turnId", "requestId", "decision"},
    "clarification.resolve": {"type", "version", "turnId", "requestId", "response"},
    "turn.cancel": {"type", "version", "turnId"},
    "heartbeat": {"type", "version", "nonce"},
}


def _uuid(value, field):
    if not isinstance(value, str):
        raise ProtocolViolation(f"{field} must be a UUID")
    try:
        UUID(value)
    except (ValueError, AttributeError):
        raise ProtocolViolation(f"{field} must be a UUID") from None


def _validate_client_event(event):
    if not isinstance(event, dict):
        raise ProtocolViolation("control frame must be an object")
    event_type = event.get("type")
    if event_type not in _CLIENT_KEYS:
        raise ProtocolViolation("unsupported client event type")
    if event.get("version") != PROTOCOL_VERSION:
        raise ProtocolViolation("unsupported protocol version")
    if set(event) != _CLIENT_KEYS[event_type]:
        raise ProtocolViolation("unexpected or missing control-frame field")
    if event_type != "heartbeat":
        _uuid(event["turnId"], "turnId")
    if event_type == "attachment.upload.begin":
        attachment = event["attachment"]
        if not isinstance(attachment, dict) or set(attachment) != {"id", "name", "declaredMime", "kind", "sizeBytes", "sha256"}:
            raise ProtocolViolation("invalid attachment")
        _uuid(attachment["id"], "attachment.id")
    elif event_type == "turn.start":
        _uuid(event["conversationId"], "conversationId")
        if not isinstance(event["attachmentIds"], list):
            raise ProtocolViolation("attachmentIds must be a list")
        for attachment_id in event["attachmentIds"]:
            _uuid(attachment_id, "attachmentId")
    elif event_type in {"approval.resolve", "clarification.resolve"}:
        _uuid(event["requestId"], "requestId")
    return event


def decode_client_event(raw):
    try:
        event = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as error:
        raise ProtocolViolation("invalid JSON control frame") from error
    _validate_client_event(event)
    return json.loads(json.dumps(event))


def encode_event(event):
    try:
        return json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError) as error:
        raise ProtocolViolation("event is not JSON serializable") from error


def encode_binary_frame(chunk):
    if not isinstance(chunk.direction, BinaryDirection):
        raise ProtocolViolation("invalid binary direction")
    if not isinstance(chunk.attachment_id, UUID):
        raise ProtocolViolation("attachment_id must be a UUID")
    if not isinstance(chunk.payload, bytes) or len(chunk.payload) > MAX_CHUNK_BYTES:
        raise ProtocolViolation("payload exceeds maximum chunk size")
    if not isinstance(chunk.chunk_index, int) or not 0 <= chunk.chunk_index <= 0xFFFFFFFF:
        raise ProtocolViolation("invalid chunk index")
    flags = 1 if chunk.final else 0
    return HEADER.pack(MAGIC, PROTOCOL_VERSION, int(chunk.direction), flags, 0, chunk.attachment_id.bytes, chunk.chunk_index, len(chunk.payload)) + chunk.payload


def decode_binary_frame(raw):
    if not isinstance(raw, bytes) or len(raw) < HEADER_BYTES:
        raise ProtocolViolation("binary frame is shorter than header")
    magic, version, direction, flags, reserved, attachment, index, length = HEADER.unpack(raw[:HEADER_BYTES])
    if magic != MAGIC:
        raise ProtocolViolation("invalid binary frame magic")
    if version != PROTOCOL_VERSION:
        raise ProtocolViolation("unsupported binary frame version")
    try:
        binary_direction = BinaryDirection(direction)
    except ValueError:
        raise ProtocolViolation("invalid binary direction") from None
    if flags & ~1 or reserved:
        raise ProtocolViolation("reserved binary frame flags")
    payload = raw[HEADER_BYTES:]
    if length != len(payload):
        raise ProtocolViolation("binary payload length mismatch")
    if length > MAX_CHUNK_BYTES:
        raise ProtocolViolation("payload exceeds maximum chunk size")
    return BinaryChunk(binary_direction, UUID(bytes=attachment), index, bool(flags & 1), payload)
