"""Bounded upload and download streaming for the Hermes transport."""
import hashlib
import os
import stat
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
    def __init__(
        self,
        temp_root,
        root_descriptor,
        metadata,
        attachment_id,
        partial_name,
        descriptor,
        file_identity,
    ):
        self.temp_root = temp_root
        self._root_descriptor = root_descriptor
        self.metadata = metadata
        self.attachment_id = attachment_id
        self._active_name = partial_name
        self.partial_path = temp_root / partial_name
        self._descriptor = descriptor
        self._file_identity = file_identity
        self._hasher = hashlib.sha256()
        self._received_bytes = 0
        self._next_chunk_index = 0
        self._received_final = False
        self._finished = False

    @classmethod
    def begin(cls, temp_root: Path, metadata: dict):
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

        requested_root = Path(temp_root)
        try:
            if requested_root.is_symlink():
                raise ValueError("temporary root must not be a symlink")
            root = requested_root.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError("temporary root does not exist") from error
        if not root.is_dir():
            raise ValueError("temporary root must be a directory")

        root_flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            root_flags |= os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            root_flags |= os.O_NOFOLLOW
        try:
            root_descriptor = os.open(str(root), root_flags)
        except OSError as error:
            raise ValueError("temporary root is not safely accessible") from error
        try:
            root_stat = os.fstat(root_descriptor)
        except Exception:
            try:
                os.close(root_descriptor)
            except OSError:
                pass
            raise
        if not stat.S_ISDIR(root_stat.st_mode):
            os.close(root_descriptor)
            raise ValueError("temporary root must be a directory")

        partial_name = f"{attachment_id}.{uuid4().hex}.partial"
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = None
        try:
            descriptor = os.open(partial_name, flags, 0o600, dir_fd=root_descriptor)
            descriptor_stat = os.fstat(descriptor)
            file_identity = (descriptor_stat.st_dev, descriptor_stat.st_ino)
            return cls(
                root,
                root_descriptor,
                dict(metadata),
                attachment_id,
                partial_name,
                descriptor,
                file_identity,
            )
        except Exception:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            try:
                os.unlink(partial_name, dir_fd=root_descriptor)
            except OSError:
                pass
            try:
                os.close(root_descriptor)
            except OSError:
                pass
            raise

    def _root_is_stable(self):
        if self._root_descriptor is None:
            return False
        try:
            path_stat = os.stat(str(self.temp_root), follow_symlinks=False)
            root_stat = os.fstat(self._root_descriptor)
        except OSError:
            return False
        return (
            stat.S_ISDIR(path_stat.st_mode)
            and path_stat.st_dev == root_stat.st_dev
            and path_stat.st_ino == root_stat.st_ino
        )

    def _active_file_is_original(self):
        if self._root_descriptor is None or self._active_name is None:
            return False
        try:
            file_stat = os.stat(
                self._active_name,
                dir_fd=self._root_descriptor,
                follow_symlinks=False,
            )
        except OSError:
            return False
        return (file_stat.st_dev, file_stat.st_ino) == self._file_identity

    def _close_root(self):
        descriptor = self._root_descriptor
        self._root_descriptor = None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

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
            if not chunk.payload and not chunk.final:
                raise ValueError("non-final upload chunk must contain bytes")
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
            if not self._root_is_stable() or not self._active_file_is_original():
                raise ValueError("temporary root or partial file changed")

            os.fsync(self._descriptor)
            descriptor = self._descriptor
            self._descriptor = None
            os.close(descriptor)
            read_flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                read_flags |= os.O_NOFOLLOW
            read_descriptor = os.open(
                self._active_name,
                read_flags,
                dir_fd=self._root_descriptor,
            )
            with os.fdopen(read_descriptor, "rb") as handle:
                read_stat = os.fstat(handle.fileno())
                if (read_stat.st_dev, read_stat.st_ino) != self._file_identity:
                    raise ValueError("partial upload file changed")
                mime = sniff_mime(handle, self.metadata["declaredMime"])
            if not self._root_is_stable() or not self._active_file_is_original():
                raise ValueError("temporary root or partial file changed")

            final_name = f"{self.attachment_id}.{uuid4().hex}.verified"
            os.rename(
                self._active_name,
                final_name,
                src_dir_fd=self._root_descriptor,
                dst_dir_fd=self._root_descriptor,
            )
            self._active_name = final_name
            if not self._root_is_stable() or not self._active_file_is_original():
                raise ValueError("temporary root or verified file changed")
            final_path = self.temp_root / final_name
            self._active_name = None
            self._finished = True
            self._close_root()
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
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if self._root_descriptor is not None and self._active_name is not None:
            try:
                os.unlink(self._active_name, dir_fd=self._root_descriptor)
            except OSError:
                pass
        self._active_name = None
        self._close_root()
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
