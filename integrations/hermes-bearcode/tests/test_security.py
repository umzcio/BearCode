import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from bearcode_transport.security import (
    AuthRateLimiter,
    sanitize_filename,
    validate_outbound_path,
    verify_bearer,
)


class SecurityTests(unittest.TestCase):
    def test_bearer_compare_requires_exact_secret(self):
        self.assertTrue(verify_bearer("Bearer alpha", "alpha"))
        self.assertFalse(verify_bearer("Bearer alph", "alpha"))
        self.assertFalse(verify_bearer("alpha", "alpha"))
        self.assertFalse(verify_bearer("Bearer ", "alpha"))
        self.assertFalse(verify_bearer("Basic alpha", "alpha"))

    def test_bearer_compare_rejects_non_ascii_without_raising(self):
        self.assertFalse(verify_bearer("Bearer álpha", "álpha"))
        self.assertFalse(verify_bearer("Bearer alpha", "álpha"))

    def test_rate_limiter_blocks_after_five_failures(self):
        limiter = AuthRateLimiter(max_failures=5, window_seconds=60)
        for _ in range(5):
            limiter.record_failure("100.64.0.2", now=10)
        self.assertFalse(limiter.allowed("100.64.0.2", now=11))
        self.assertTrue(limiter.allowed("100.64.0.3", now=11))
        self.assertTrue(limiter.allowed("100.64.0.2", now=71))

    def test_filename_is_basename_and_control_free(self):
        self.assertEqual(sanitize_filename("../../bad\x00name.pdf"), "badname.pdf")
        self.assertEqual(sanitize_filename("folder\\report\t.pdf"), "report.pdf")

    def test_outbound_path_requires_regular_file_below_allowed_root(self):
        with tempfile.TemporaryDirectory() as root_name, tempfile.TemporaryDirectory() as outside_name:
            root = Path(root_name)
            inside = root / "report.txt"
            inside.write_text("safe", encoding="utf-8")
            directory = root / "directory"
            directory.mkdir()
            outside = Path(outside_name) / "secret.txt"
            outside.write_text("secret", encoding="utf-8")
            escape = root / "escape.txt"
            escape.symlink_to(outside)

            self.assertEqual(validate_outbound_path(inside, [root]), inside.resolve())
            for rejected in (directory, outside, escape, root / "missing.txt"):
                with self.subTest(path=rejected):
                    with self.assertRaises(ValueError):
                        validate_outbound_path(rejected, [root])


if __name__ == "__main__":
    unittest.main()
