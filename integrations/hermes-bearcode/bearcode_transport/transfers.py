"""Bounded upload and download streaming for the Hermes transport."""
import codecs
import hashlib
import os
import stat
import sys
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
from .security import ValidatedOutbound, sanitize_filename, sniff_mime


@dataclass(frozen=True)
class VerifiedUpload:
    attachment_id: UUID
    name: str
    mime: str
    size_bytes: int
    sha256: str
    path: Path


@dataclass
class OutboundSnapshot:
    source: ValidatedOutbound
    name: str
    mime: str
    size_bytes: int
    sha256: str
    _root_descriptor: int = None
    _active_name: str = None
    _file_identity: tuple = None

    def metadata(self, attachment_id):
        return {
            "id": str(attachment_id),
            "name": self.name,
            "mime": self.mime,
            "kind": (
                "image"
                if self.mime.startswith("image/")
                else "document"
            ),
            "sizeBytes": self.size_bytes,
            "sha256": self.sha256,
        }

    def close(self):
        self.source.close()
        root_descriptor = self._root_descriptor
        active_name = self._active_name
        self._root_descriptor = None
        self._active_name = None
        if root_descriptor is None:
            return
        try:
            if active_name is not None:
                _unlink_owned_name(
                    root_descriptor,
                    active_name,
                    self._file_identity,
                )
        finally:
            try:
                os.close(root_descriptor)
            except OSError:
                pass

    def __del__(self):
        self.close()


def _unlink_owned_name(root_descriptor, active_name, file_identity):
    try:
        file_stat = os.stat(
            active_name,
            dir_fd=root_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        return True
    if (file_stat.st_dev, file_stat.st_ino) != file_identity:
        return False
    try:
        os.unlink(active_name, dir_fd=root_descriptor)
    except OSError:
        return False
    return True


def create_outbound_snapshot(source, temp_root):
    """Copy a validated source into one private, immutable owned descriptor."""
    if not isinstance(source, ValidatedOutbound) or source.closed:
        raise ValueError("snapshot source must be a validated outbound file")
    root = Path(os.path.abspath(os.fspath(temp_root)))
    root_descriptor = None
    snapshot_descriptor = None
    active_name = None
    file_identity = None
    snapshot = None
    try:
        root_flags = os.O_RDONLY | os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            root_flags |= os.O_NOFOLLOW
        root_descriptor = os.open(str(root), root_flags)
        root_stat = os.fstat(root_descriptor)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise ValueError("snapshot root must be a directory")

        active_name = f".{uuid4().hex}.outbound-snapshot"
        snapshot_flags = os.O_CREAT | os.O_EXCL | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            snapshot_flags |= os.O_NOFOLLOW
        snapshot_descriptor = os.open(
            active_name,
            snapshot_flags,
            0o600,
            dir_fd=root_descriptor,
        )
        snapshot_path = root / active_name
        snapshot_stat = os.fstat(snapshot_descriptor)
        file_identity = (snapshot_stat.st_dev, snapshot_stat.st_ino)
        if _unlink_owned_name(
            root_descriptor,
            active_name,
            file_identity,
        ):
            active_name = None
            os.close(root_descriptor)
            root_descriptor = None

        digest = hashlib.sha256()
        utf8_decoder = codecs.getincrementaldecoder("utf-8")("strict")
        valid_utf8 = True
        size_bytes = 0
        os.lseek(source._descriptor, 0, os.SEEK_SET)
        while True:
            remaining = MAX_FILE_BYTES - size_bytes
            read_size = min(MAX_CHUNK_BYTES, remaining + 1)
            chunk = os.read(source._descriptor, read_size)
            if not chunk:
                break
            size_bytes += len(chunk)
            if size_bytes > MAX_FILE_BYTES:
                raise ValueError("download exceeds maximum file size")
            view = memoryview(chunk)
            while view:
                written = os.write(snapshot_descriptor, view)
                if written <= 0:
                    raise OSError("failed to write outbound snapshot")
                view = view[written:]
            digest.update(chunk)
            if valid_utf8:
                try:
                    utf8_decoder.decode(chunk, final=False)
                except UnicodeDecodeError:
                    valid_utf8 = False
        if valid_utf8:
            try:
                utf8_decoder.decode(b"", final=True)
            except UnicodeDecodeError:
                valid_utf8 = False
        os.fsync(snapshot_descriptor)
        os.lseek(snapshot_descriptor, 0, os.SEEK_SET)

        sniff_descriptor = os.dup(snapshot_descriptor)
        try:
            with os.fdopen(sniff_descriptor, "rb") as handle:
                sniff_descriptor = None
                try:
                    mime = sniff_mime(
                        handle,
                        "application/octet-stream",
                    )
                except ValueError:
                    mime = None
        finally:
            if sniff_descriptor is not None:
                os.close(sniff_descriptor)
            os.lseek(snapshot_descriptor, 0, os.SEEK_SET)
        if mime is None:
            if not valid_utf8:
                raise ValueError(
                    "unsupported or invalid outbound file type"
                )
            mime = "text/plain"

        validated = ValidatedOutbound(
            path=snapshot_path,
            _descriptor=snapshot_descriptor,
            device=snapshot_stat.st_dev,
            inode=snapshot_stat.st_ino,
        )
        snapshot_descriptor = None
        name = sanitize_filename(source.path.name)
        if (
            root_descriptor is not None
            and _unlink_owned_name(
                root_descriptor,
                active_name,
                file_identity,
            )
        ):
            active_name = None
            os.close(root_descriptor)
            root_descriptor = None
        snapshot = OutboundSnapshot(
            source=validated,
            name=name,
            mime=mime,
            size_bytes=size_bytes,
            sha256=digest.hexdigest(),
            _root_descriptor=root_descriptor,
            _active_name=active_name,
            _file_identity=file_identity,
        )
        root_descriptor = None
        active_name = None
        return snapshot
    finally:
        source.close()
        if snapshot is None:
            if snapshot_descriptor is not None:
                try:
                    os.close(snapshot_descriptor)
                except OSError:
                    pass
            if (
                root_descriptor is not None
                and active_name is not None
                and file_identity is not None
            ):
                _unlink_owned_name(
                    root_descriptor,
                    active_name,
                    file_identity,
                )
            if root_descriptor is not None:
                try:
                    os.close(root_descriptor)
                except OSError:
                    pass


def _cleanup_owned_name(root_descriptor, active_name, file_identity):
    quarantine_name = f".{uuid4().hex}.cleanup"
    try:
        os.rename(
            active_name,
            quarantine_name,
            src_dir_fd=root_descriptor,
            dst_dir_fd=root_descriptor,
        )
    except OSError:
        return None
    try:
        quarantined_stat = os.stat(
            quarantine_name,
            dir_fd=root_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        return quarantine_name
    if (quarantined_stat.st_dev, quarantined_stat.st_ino) == file_identity:
        try:
            os.unlink(quarantine_name, dir_fd=root_descriptor)
        except OSError:
            pass
        return None

    try:
        os.link(
            quarantine_name,
            active_name,
            src_dir_fd=root_descriptor,
            dst_dir_fd=root_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        recovery_base = (
            f"recovery-{quarantined_stat.st_dev:x}-"
            f"{quarantined_stat.st_ino:x}.preserved"
        )
        recovery_name = recovery_base
        suffix = 0
        while True:
            try:
                os.stat(
                    recovery_name,
                    dir_fd=root_descriptor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                break
            except OSError:
                return quarantine_name
            suffix += 1
            recovery_name = f"{recovery_base}.{suffix}"
        try:
            os.rename(
                quarantine_name,
                recovery_name,
                src_dir_fd=root_descriptor,
                dst_dir_fd=root_descriptor,
            )
        except OSError:
            return quarantine_name
        return recovery_name
    try:
        os.unlink(quarantine_name, dir_fd=root_descriptor)
    except OSError:
        pass
    return None


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
        self.recovery_paths = []

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

        if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
            raise RuntimeError("platform lacks race-free directory acquisition")
        root = Path(os.path.abspath(os.fspath(temp_root)))
        root_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
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
        file_identity = None
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
            if file_identity is not None:
                _cleanup_owned_name(root_descriptor, partial_name, file_identity)
            elif descriptor is not None:
                try:
                    os.unlink(partial_name, dir_fd=root_descriptor)
                except OSError:
                    pass
            try:
                os.close(root_descriptor)
            except OSError:
                pass
            raise

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

    def _anchored_root_path(self):
        if self._root_descriptor is None:
            raise ValueError("temporary root is closed")
        try:
            if sys.platform == "darwin":
                import fcntl

                raw_path = fcntl.fcntl(self._root_descriptor, 50, b"\0" * 1024)
                return Path(raw_path.split(b"\0", 1)[0].decode())
            return Path(os.readlink(f"/proc/self/fd/{self._root_descriptor}"))
        except (OSError, UnicodeDecodeError) as error:
            raise ValueError("cannot identify anchored temporary root") from error

    def _close_root(self):
        descriptor = self._root_descriptor
        self._root_descriptor = None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def _cleanup_active_file(self):
        if self._root_descriptor is None or self._active_name is None:
            return
        recovery_name = _cleanup_owned_name(
            self._root_descriptor,
            self._active_name,
            self._file_identity,
        )
        if recovery_name is not None:
            try:
                root_path = self._anchored_root_path()
            except ValueError:
                root_path = self.temp_root
            self.recovery_paths.append(root_path / recovery_name)

    def _truncate_and_close_upload(self):
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is None:
            return
        try:
            os.ftruncate(descriptor, 0)
            try:
                os.fsync(descriptor)
            except OSError:
                pass
        except OSError:
            pass
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
            if not self._active_file_is_original():
                raise ValueError("partial file changed")

            os.fsync(self._descriptor)
            read_flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                read_flags |= os.O_NOFOLLOW
            read_descriptor = os.open(
                self._active_name,
                read_flags,
                dir_fd=self._root_descriptor,
            )
            try:
                handle = os.fdopen(read_descriptor, "rb")
            except Exception:
                try:
                    os.close(read_descriptor)
                except OSError:
                    pass
                raise
            with handle:
                read_stat = os.fstat(handle.fileno())
                if (read_stat.st_dev, read_stat.st_ino) != self._file_identity:
                    raise ValueError("partial upload file changed")
                mime = sniff_mime(handle, self.metadata["declaredMime"])
            if not self._active_file_is_original():
                raise ValueError("partial file changed")

            final_name = f"{self.attachment_id}.{uuid4().hex}.verified"
            os.rename(
                self._active_name,
                final_name,
                src_dir_fd=self._root_descriptor,
                dst_dir_fd=self._root_descriptor,
            )
            self._active_name = final_name
            if not self._active_file_is_original():
                raise ValueError("verified file changed")
            final_path = self._anchored_root_path() / final_name
            descriptor = self._descriptor
            os.close(descriptor)
            self._descriptor = None
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
        self._truncate_and_close_upload()
        self._cleanup_active_file()
        self._active_name = None
        self._close_root()
        self._finished = True


class _DownloadFrameIterator:
    def __init__(self, source, attachment_id):
        self._attachment_id = attachment_id
        self._handle = None
        self._error = None
        self._index = 0
        self._remaining = 0
        self._empty_pending = False
        descriptor = source.take_descriptor()
        try:
            source_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(source_stat.st_mode)
                or source_stat.st_dev != source.device
                or source_stat.st_ino != source.inode
            ):
                raise ValueError("validated outbound file identity changed")
            if source_stat.st_size > MAX_FILE_BYTES:
                raise ValueError("download exceeds maximum file size")
            if not isinstance(attachment_id, UUID):
                raise ValueError("attachment_id must be a UUID")
            self._handle = os.fdopen(descriptor, "rb")
            descriptor = None
            self._remaining = source_stat.st_size
            self._empty_pending = self._remaining == 0
        except Exception as error:
            self._error = error
        finally:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def __iter__(self):
        return self

    def __next__(self):
        if self._error is not None:
            error = self._error
            self._error = None
            raise error
        if self._handle is None:
            raise StopIteration
        try:
            if self._empty_pending:
                self._empty_pending = False
                frame = encode_binary_frame(
                    BinaryChunk(BinaryDirection.DOWNLOAD, self._attachment_id, 0, True, b"")
                )
                self.close()
                return frame
            payload = self._handle.read(min(MAX_CHUNK_BYTES, self._remaining))
            if not payload:
                raise ValueError("download changed while streaming")
            self._remaining -= len(payload)
            frame = encode_binary_frame(
                BinaryChunk(
                    BinaryDirection.DOWNLOAD,
                    self._attachment_id,
                    self._index,
                    self._remaining == 0,
                    payload,
                )
            )
            self._index += 1
            if self._remaining == 0:
                self.close()
            return frame
        except Exception:
            self.close()
            raise

    def close(self):
        handle = self._handle
        self._handle = None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    def __del__(self):
        self.close()


def iter_download_frames(source: ValidatedOutbound, attachment_id: UUID):
    if not isinstance(source, ValidatedOutbound):
        raise ValueError("download source must be a validated outbound file")
    return _DownloadFrameIterator(source, attachment_id)
