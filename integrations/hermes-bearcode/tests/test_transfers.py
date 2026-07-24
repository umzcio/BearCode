import hashlib
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).parents[1]))

from bearcode_transport.protocol import (
    MAX_CHUNK_BYTES,
    MAX_FILE_BYTES,
    BinaryChunk,
    BinaryDirection,
    decode_binary_frame,
)
from bearcode_transport.transfers import UploadTransfer, iter_download_frames


ATTACHMENT_ID = UUID("55555555-5555-4555-8555-555555555555")


def metadata(data, *, name="report.txt", declared_mime="text/plain", size=None, digest=None):
    return {
        "id": str(ATTACHMENT_ID),
        "name": name,
        "declaredMime": declared_mime,
        "kind": "file",
        "sizeBytes": len(data) if size is None else size,
        "sha256": hashlib.sha256(data).hexdigest() if digest is None else digest,
    }


def upload_chunk(index, payload, *, final=False, attachment_id=ATTACHMENT_ID, direction=BinaryDirection.UPLOAD):
    return BinaryChunk(direction, attachment_id, index, final, payload)


class UploadTransferTests(unittest.TestCase):
    def test_oversize_declaration_rejects_before_file_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                UploadTransfer.begin(root, metadata(b"", size=MAX_FILE_BYTES + 1))
            self.assertEqual(list(root.iterdir()), [])

    def test_chunks_must_be_contiguous_and_match_upload(self):
        bad_chunks = (
            upload_chunk(1, b"x"),
            upload_chunk(0, b"x", attachment_id=UUID("66666666-6666-4666-8666-666666666666")),
            upload_chunk(0, b"x", direction=BinaryDirection.DOWNLOAD),
        )
        for bad_chunk in bad_chunks:
            with self.subTest(chunk=bad_chunk):
                with tempfile.TemporaryDirectory() as directory:
                    transfer = UploadTransfer.begin(Path(directory), metadata(b"x"))
                    with self.assertRaises(ValueError):
                        transfer.append(bad_chunk)
                    self.assertEqual(list(Path(directory).glob("*.partial")), [])

    def test_chunk_final_flag_must_be_boolean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transfer = UploadTransfer.begin(root, metadata(b"x"))
            chunk = BinaryChunk(BinaryDirection.UPLOAD, ATTACHMENT_ID, 0, "yes", b"x")
            with self.assertRaises(ValueError):
                transfer.append(chunk)
            self.assertEqual(list(root.glob("*.partial")), [])

    def test_chunk_index_must_not_be_boolean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transfer = UploadTransfer.begin(root, metadata(b"x"))
            chunk = BinaryChunk(BinaryDirection.UPLOAD, ATTACHMENT_ID, False, True, b"x")
            with self.assertRaises(ValueError):
                transfer.append(chunk)
            self.assertEqual(list(root.glob("*.partial")), [])

    def test_stream_cannot_exceed_declared_size_and_failure_cleans_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transfer = UploadTransfer.begin(root, metadata(b"x"))
            with self.assertRaises(ValueError):
                transfer.append(upload_chunk(0, b"xx", final=True))
            self.assertEqual(list(root.glob("*.partial")), [])

    def test_final_length_and_sha256_must_match(self):
        cases = (
            metadata(b"xx", size=2),
            metadata(b"x", digest="0" * 64),
        )
        chunks = (
            upload_chunk(0, b"x", final=True),
            upload_chunk(0, b"x", final=True),
        )
        for transfer_metadata, chunk in zip(cases, chunks):
            with self.subTest(metadata=transfer_metadata):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    transfer = UploadTransfer.begin(root, transfer_metadata)
                    transfer.append(chunk)
                    with self.assertRaises(ValueError):
                        transfer.complete()
                    self.assertEqual(list(root.glob("*.partial")), [])

    def test_abort_removes_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transfer = UploadTransfer.begin(root, metadata(b"x"))
            self.assertEqual(len(list(root.glob("*.partial"))), 1)
            transfer.abort()
            transfer.abort()
            self.assertEqual(list(root.iterdir()), [])

    def test_completion_returns_verified_metadata_and_atomically_renamed_path(self):
        data = b"hello, Hermes"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transfer = UploadTransfer.begin(root, metadata(data))
            transfer.append(upload_chunk(0, data[:5]))
            transfer.append(upload_chunk(1, data[5:], final=True))
            verified = transfer.complete()

            self.assertEqual(verified.attachment_id, ATTACHMENT_ID)
            self.assertEqual(verified.name, "report.txt")
            self.assertEqual(verified.size_bytes, len(data))
            self.assertEqual(verified.sha256, hashlib.sha256(data).hexdigest())
            self.assertEqual(verified.mime, "text/plain")
            self.assertEqual(verified.path.read_bytes(), data)
            self.assertEqual(verified.path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(verified.path.name.endswith(".partial"))
            self.assertEqual(list(root.glob("*.partial")), [])

    def test_mime_is_sniffed_instead_of_trusting_declaration(self):
        png = b"\x89PNG\r\n\x1a\n" + b"payload"
        with tempfile.TemporaryDirectory() as directory:
            transfer = UploadTransfer.begin(
                Path(directory),
                metadata(png, name="fake.txt", declared_mime="text/plain"),
            )
            transfer.append(upload_chunk(0, png, final=True))
            self.assertEqual(transfer.complete().mime, "image/png")

    def test_invalid_utf8_text_and_unsupported_binary_are_rejected(self):
        for data, declared in ((b"\xff", "text/plain"), (b"untyped", "application/octet-stream")):
            with self.subTest(declared=declared):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    transfer = UploadTransfer.begin(root, metadata(data, declared_mime=declared))
                    transfer.append(upload_chunk(0, data, final=True))
                    with self.assertRaises(ValueError):
                        transfer.complete()
                    self.assertEqual(list(root.iterdir()), [])

    def test_ooxml_type_is_distinguished_by_zip_members(self):
        cases = (
            ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        )
        for member, expected_mime in cases:
            with self.subTest(member=member):
                with tempfile.TemporaryDirectory() as build_directory, tempfile.TemporaryDirectory() as upload_directory:
                    archive = Path(build_directory) / "office.zip"
                    with zipfile.ZipFile(archive, "w") as package:
                        package.writestr("[Content_Types].xml", "<Types/>")
                        package.writestr(member, "content")
                    data = archive.read_bytes()
                    transfer = UploadTransfer.begin(
                        Path(upload_directory),
                        metadata(data, declared_mime="application/zip"),
                    )
                    transfer.append(upload_chunk(0, data, final=True))
                    self.assertEqual(transfer.complete().mime, expected_mime)


class DownloadTransferTests(unittest.TestCase):
    def test_download_chunks_are_bounded_contiguous_and_have_one_final(self):
        data = os.urandom(MAX_CHUNK_BYTES * 2 + 7)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "download.bin"
            path.write_bytes(data)
            chunks = [decode_binary_frame(frame) for frame in iter_download_frames(path, ATTACHMENT_ID)]

            self.assertEqual(b"".join(chunk.payload for chunk in chunks), data)
            self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1, 2])
            self.assertTrue(all(chunk.direction is BinaryDirection.DOWNLOAD for chunk in chunks))
            self.assertTrue(all(len(chunk.payload) <= MAX_CHUNK_BYTES for chunk in chunks))
            self.assertEqual([chunk.final for chunk in chunks], [False, False, True])

    def test_oversize_download_rejects_before_first_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.bin"
            with path.open("wb") as handle:
                handle.truncate(MAX_FILE_BYTES + 1)
            frames = iter_download_frames(path, ATTACHMENT_ID)
            with self.assertRaises(ValueError):
                next(frames)

    def test_empty_download_has_one_zero_byte_final_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.txt"
            path.touch()
            chunks = [decode_binary_frame(frame) for frame in iter_download_frames(path, ATTACHMENT_ID)]
            self.assertEqual(len(chunks), 1)
            self.assertEqual(chunks[0].payload, b"")
            self.assertTrue(chunks[0].final)
            self.assertEqual(chunks[0].chunk_index, 0)


if __name__ == "__main__":
    unittest.main()
