"""Bounded upload and download streaming for the Hermes transport."""
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from .protocol import (
    MAX_CHUNK_BYTES,
    MAX_FILE_BYTES,
    BinaryChunk,
    BinaryDirection,
    encode_binary_frame,
)
from .security import sanitize_filename, sniff_mime


@dataclass(frozen=True)
class VerifiedUpload:
    attachment_id: UUID
    name: str
    mime: str
    size_bytes: int
    sha256: str
    path: Path


class UploadTransfer:
    def __init__(self, temp_root, metadata, attachment_id, partial_path, descriptor):
        self.temp_root = temp_root
        self.metadata = metadata
        self.attachment_id = attachment_id
        self.partial_path = partial_path
        self._descriptor = descriptor
        self._hasher = hashlib.sha256()
        self._received_bytes = 0
        self._next_chunk_index = 0
        self._received_final = False
        self._finished = False

    @classmethod
    def begin(cls, temp_root: Path, metadata: dict):
        root = Path(temp_root)
        if not isinstance(metadata, dict):
            raise ValueError("upload metadata must be an object")
        try:
            attachment_id = UUID(metadata["id"])
            declared_size = metadata["sizeBytes"]
            digest = metadata["sha256"]
            sanitize_filename(metadata["name"])
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ValueError("invalid upload metadata") from error
        if (
            not isinstance(declared_size, int)
            or isinstance(declared_size, bool)
            or declared_size < 0
            or declared_size > MAX_FILE_BYTES
        ):
            raise ValueError("declared upload size is invalid")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or digest.lower() != digest
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise ValueError("declared SHA-256 is invalid")
        if not isinstance(metadata.get("declaredMime"), str):
            raise ValueError("declared MIME must be a string")

        partial_path = root / f"{attachment_id}.{uuid4().hex}.partial"
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(str(partial_path), flags, 0o600)
        return cls(root, dict(metadata), attachment_id, partial_path, descriptor)

    def append(self, chunk: BinaryChunk) -> None:
        try:
            if self._finished or self._descriptor is None:
                raise ValueError("upload is no longer active")
            if self._received_final:
                raise ValueError("final upload chunk was already received")
            if not isinstance(chunk, BinaryChunk):
                raise ValueError("upload chunk is invalid")
            if chunk.direction is not BinaryDirection.UPLOAD:
                raise ValueError("upload chunk has the wrong direction")
            if chunk.attachment_id != self.attachment_id:
                raise ValueError("upload chunk has the wrong attachment")
            if not isinstance(chunk.chunk_index, int) or isinstance(chunk.chunk_index, bool):
                raise ValueError("upload chunk index is invalid")
            if chunk.chunk_index != self._next_chunk_index:
                raise ValueError("upload chunks must be contiguous")
            if not isinstance(chunk.final, bool):
                raise ValueError("upload chunk final flag is invalid")
            if not isinstance(chunk.payload, bytes) or len(chunk.payload) > MAX_CHUNK_BYTES:
                raise ValueError("upload chunk payload is invalid")
            next_size = self._received_bytes + len(chunk.payload)
            if next_size > self.metadata["sizeBytes"] or next_size > MAX_FILE_BYTES:
                raise ValueError("upload exceeds declared size")

            view = memoryview(chunk.payload)
            while view:
                written = os.write(self._descriptor, view)
                if written <= 0:
                    raise OSError("failed to write upload")
                view = view[written:]
            self._hasher.update(chunk.payload)
            self._received_bytes = next_size
            self._next_chunk_index += 1
            self._received_final = chunk.final
        except Exception:
            self.abort()
            raise

    def complete(self) -> VerifiedUpload:
        try:
            if self._finished or self._descriptor is None:
                raise ValueError("upload is no longer active")
            if not self._received_final:
                raise ValueError("upload is missing its final chunk")
            if self._received_bytes != self.metadata["sizeBytes"]:
                raise ValueError("upload length does not match declaration")
            digest = self._hasher.hexdigest()
            if digest != self.metadata["sha256"]:
                raise ValueError("upload SHA-256 does not match declaration")

            os.fsync(self._descriptor)
            os.close(self._descriptor)
            self._descriptor = None
            mime = sniff_mime(self.partial_path, self.metadata["declaredMime"])
            final_path = self.temp_root / f"{self.attachment_id}.{uuid4().hex}.verified"
            os.rename(str(self.partial_path), str(final_path))
            self._finished = True
            return VerifiedUpload(
                attachment_id=self.attachment_id,
                name=sanitize_filename(self.metadata["name"]),
                mime=mime,
                size_bytes=self._received_bytes,
                sha256=digest,
                path=final_path,
            )
        except Exception:
            self.abort()
            raise

    def abort(self) -> None:
        if self._descriptor is not None:
            try:
                os.close(self._descriptor)
            finally:
                self._descriptor = None
        try:
            self.partial_path.unlink()
        except FileNotFoundError:
            pass
        self._finished = True


def iter_download_frames(path: Path, attachment_id: UUID):
    source = Path(path)
    size = source.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError("download exceeds maximum file size")
    if not source.is_file():
        raise ValueError("download path must be a regular file")
    if not isinstance(attachment_id, UUID):
        raise ValueError("attachment_id must be a UUID")

    with source.open("rb") as handle:
        if size == 0:
            yield encode_binary_frame(BinaryChunk(BinaryDirection.DOWNLOAD, attachment_id, 0, True, b""))
            return
        index = 0
        remaining = size
        while remaining:
            payload = handle.read(min(MAX_CHUNK_BYTES, remaining))
            if not payload:
                raise ValueError("download changed while streaming")
            remaining -= len(payload)
            yield encode_binary_frame(
                BinaryChunk(BinaryDirection.DOWNLOAD, attachment_id, index, remaining == 0, payload)
            )
            index += 1
