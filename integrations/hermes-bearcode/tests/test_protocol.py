import json
import sys
import unittest
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).parents[1]))

from bearcode_transport.protocol import (
    BinaryChunk,
    BinaryDirection,
    ProtocolViolation,
    decode_binary_frame,
    decode_client_event,
    encode_binary_frame,
    encode_event,
)


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture_dir = Path(__file__).parents[1] / "fixtures/protocol-v1"
        cls.hello = json.loads((fixture_dir / "hello.json").read_text())
        cls.events = json.loads((fixture_dir / "events.json").read_text())
        cls.binary = json.loads((fixture_dir / "binary.json").read_text())

    def test_binary_fixture_round_trips(self):
        raw = bytes.fromhex(self.binary["headerHex"] + self.binary["payloadHex"])
        decoded = decode_binary_frame(raw)
        self.assertEqual(decoded.direction, BinaryDirection.UPLOAD)
        self.assertEqual(str(decoded.attachment_id), self.binary["attachmentId"])
        self.assertEqual(decoded.chunk_index, 0)
        self.assertTrue(decoded.final)
        self.assertEqual(decoded.payload, b"\x00\x01\x02\x03")
        self.assertEqual(encode_binary_frame(decoded), raw)

    def test_rejects_payload_larger_than_256_kib(self):
        chunk = BinaryChunk(BinaryDirection.UPLOAD, UUID("55555555-5555-4555-8555-555555555555"), 0, True, b"x" * (262144 + 1))
        with self.assertRaisesRegex(ProtocolViolation, "payload"):
            encode_binary_frame(chunk)

    def test_decodes_every_client_fixture(self):
        for event in self.events["clientEvents"]:
            self.assertEqual(decode_client_event(encode_event(event)), event)

    def test_encodes_every_server_fixture(self):
        for event in self.events["serverEvents"]:
            self.assertEqual(json.loads(encode_event(event)), event)

    def test_rejects_invalid_binary_frames(self):
        raw = bytes.fromhex(self.binary["headerHex"] + self.binary["payloadHex"])
        for invalid in (b"NOPE" + raw[4:], raw[:6] + b"\x02" + raw[7:], raw[:-1]):
            with self.assertRaises(ProtocolViolation):
                decode_binary_frame(invalid)

    def test_rejects_invalid_control_frames(self):
        for event in ({"type": "turn.start", "version": 2}, {"type": "turn.start", "version": 1, "turnId": "not-a-uuid"}):
            with self.assertRaises(ProtocolViolation):
                decode_client_event(encode_event(event))


if __name__ == "__main__":
    unittest.main()
