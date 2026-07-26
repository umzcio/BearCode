"""Authentication and file-validation helpers for the Hermes transport."""
import hmac
import os
import re
import stat
import time
import unicodedata
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path


ALLOWED_MIMES = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
})

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_SNIFF_BYTES = 64 * 1024
_TEXT_MIME = re.compile(r"text/[a-z0-9][a-z0-9!#$&^_.+-]*", re.ASCII)


@dataclass
class ValidatedOutbound:
    path: Path
    _descriptor: int
    device: int
    inode: int

    @property
    def closed(self):
        return self._descriptor is None

    def take_descriptor(self):
        if self._descriptor is None:
            raise ValueError("validated outbound file is closed")
        descriptor = self._descriptor
        self._descriptor = None
        return descriptor

    def close(self):
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def __enter__(self):
        if self.closed:
            raise ValueError("validated outbound file is closed")
        return self

    def __exit__(self, _error_type, _error, _traceback):
        self.close()

    def __del__(self):
        self.close()


def verify_bearer(authorization, expected_secret):
    if not isinstance(authorization, str) or not isinstance(expected_secret, str):
        return False
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0] != "Bearer" or not parts[1] or not expected_secret:
        return False
    try:
        token = parts[1].encode("ascii")
        secret = expected_secret.encode("ascii")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(token, secret)


class AuthRateLimiter:
    def __init__(self, max_failures=5, window_seconds=60):
        if not isinstance(max_failures, int) or isinstance(max_failures, bool) or max_failures <= 0:
            raise ValueError("max_failures must be positive")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures = defaultdict(list)

    def _prune(self, remote_address, now):
        cutoff = now - self.window_seconds
        recent = [timestamp for timestamp in self._failures.get(remote_address, ()) if timestamp > cutoff]
        if recent:
            self._failures[remote_address] = recent
        else:
            self._failures.pop(remote_address, None)
        return recent

    def allowed(self, remote_address, now=None):
        current = time.monotonic() if now is None else now
        return len(self._prune(remote_address, current)) < self.max_failures

    def record_failure(self, remote_address, now=None):
        current = time.monotonic() if now is None else now
        self._prune(remote_address, current)
        self._failures[remote_address].append(current)


def sanitize_filename(filename):
    if not isinstance(filename, str):
        raise ValueError("filename must be a string")
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(character for character in basename if unicodedata.category(character)[0] != "C")
    return cleaned or "attachment"


def validate_outbound_path(path, allowed_roots):
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("platform lacks race-free file acquisition")
    candidate = Path(os.path.abspath(os.fspath(path)))
    matched_root = False
    for allowed_root in allowed_roots:
        root = Path(os.path.abspath(os.fspath(allowed_root)))
        try:
            relative = candidate.relative_to(root)
        except ValueError:
            continue
        matched_root = True
        if not relative.parts:
            continue

        directory_descriptors = []
        file_descriptor = None
        try:
            root_descriptor = os.open(
                str(root),
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            )
            directory_descriptors.append(root_descriptor)
            current_descriptor = root_descriptor
            for component in relative.parts[:-1]:
                next_descriptor = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current_descriptor,
                )
                directory_descriptors.append(next_descriptor)
                current_descriptor = next_descriptor
            file_descriptor = os.open(
                relative.parts[-1],
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=current_descriptor,
            )
            file_stat = os.fstat(file_descriptor)
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValueError("outbound path must be a regular file")
            validated = ValidatedOutbound(
                path=candidate,
                _descriptor=file_descriptor,
                device=file_stat.st_dev,
                inode=file_stat.st_ino,
            )
            file_descriptor = None
            return validated
        except (OSError, ValueError):
            continue
        finally:
            if file_descriptor is not None:
                try:
                    os.close(file_descriptor)
                except OSError:
                    pass
            for descriptor in reversed(directory_descriptors):
                try:
                    os.close(descriptor)
                except OSError:
                    pass
    if matched_root:
        raise ValueError("outbound path is not a safe regular file")
    raise ValueError("outbound path escapes allowed roots")


def sniff_mime(source, declared_mime):
    owns_handle = not hasattr(source, "read")
    handle = Path(source).open("rb") if owns_handle else source
    try:
        handle.seek(0)
        sample = handle.read(_SNIFF_BYTES)

        if sample.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if sample.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if len(sample) >= 12 and sample.startswith(b"RIFF") and sample[8:12] == b"WEBP":
            return "image/webp"
        if sample.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if sample.startswith(b"%PDF-"):
            return "application/pdf"
        if sample.startswith(b"PK\x03\x04"):
            try:
                handle.seek(0)
                with zipfile.ZipFile(handle) as archive:
                    names = set(archive.namelist())
            except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
                names = set()
            if "[Content_Types].xml" in names:
                if any(name.startswith("word/") for name in names):
                    return _DOCX_MIME
                if any(name.startswith("xl/") for name in names):
                    return _XLSX_MIME

        normalized_declared = declared_mime.lower() if isinstance(declared_mime, str) else ""
        if _TEXT_MIME.fullmatch(normalized_declared):
            try:
                sample.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                pass
            else:
                return normalized_declared
        raise ValueError("unsupported or invalid file type")
    finally:
        if owns_handle:
            handle.close()
