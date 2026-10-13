"""Session restoration must fail closed and never echo a credential."""
from __future__ import annotations

import base64
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay_engine import session_restore  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# A real authorized session is an SQLite file whose schema includes Telethon's
# own tables. Use the actual on-disk session when present so the fixture stays
# realistic; otherwise build one with the same shape.
REAL_SESSION = b""
if (ROOT / "rrr_live.session").exists():
    REAL_SESSION = (ROOT / "rrr_live.session").read_bytes()
else:
    REAL_SESSION = (b"SQLite format 3\x00" + b"\x00" * 8
                    + b"CREATE TABLE sessions (dc_id INTEGER PRIMARY KEY)" + b"\x00" * 2048)


def encode(payload: bytes) -> str:
    return base64.b64encode(payload).decode("ascii")


class RestoreSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def with_secret(self, value: str | None):
        return patch.dict(os.environ, {"TELEGRAM_SESSION_B64": value} if value is not None else {},
                          clear=False)

    def test_secret_materializes_session_with_owner_only_permissions(self):
        target = self.base / "rrr_live"
        with self.with_secret(encode(REAL_SESSION)):
            restored = session_restore.restore_session({"session": "rrr_live"}, self.base)
        self.assertEqual(restored, target)
        written = target.with_suffix(".session")
        self.assertTrue(written.exists())
        self.assertEqual(written.read_bytes(), REAL_SESSION)
        mode = stat.S_IMODE(written.stat().st_mode)
        self.assertEqual(mode, 0o600, "a restored credential must be owner-only")

    def test_existing_local_session_is_never_overwritten(self):
        target = self.base / "rrr_live"
        target.with_suffix(".session").write_bytes(b"local session")
        with self.with_secret(encode(REAL_SESSION)):
            restored = session_restore.restore_session({"session": "rrr_live"}, self.base)
        self.assertEqual(restored, target)
        self.assertEqual(target.with_suffix(".session").read_bytes(), b"local session")

    def test_missing_secret_keeps_the_configured_local_path(self):
        with self.with_secret(None):
            restored = session_restore.restore_session({"session": "rrr_live"}, self.base)
        self.assertEqual(restored, self.base / "rrr_live")

    def test_invalid_payload_fails_closed_without_writing_a_file(self):
        good_b64 = encode(REAL_SESSION)
        cases = [
            b"",                                   # empty
            b"short",                              # far too small
            b"not a database but long enough to look like one" * 40,  # wrong magic, plausible size
            good_b64[:-12].encode("ascii"),       # truncation SQLite detects
            good_b64[: len(good_b64) // 2].encode("ascii"),  # half the file
            b"!!!!not-base64!!!!",                 # invalid alphabet
        ]
        for index, payload in enumerate(cases):
            with self.subTest(index=index, payload=payload[:24]):
                # A unique name per case: an earlier accepted file would make
                # the next restore short-circuit on "already exists".
                target = self.base / f"rejected_{index}"
                with self.with_secret(payload.decode("utf-8", "replace")):
                    with self.assertRaises(RuntimeError):
                        session_restore.restore_session({"session": str(target)}, self.base)
                self.assertFalse(target.with_suffix(".session").exists(),
                                 "a rejected payload must never become a session file")

    def test_error_message_never_contains_the_secret(self):
        secret = encode(b"definitely-not-a-session-payload")
        with self.with_secret(secret):
            with self.assertRaises(RuntimeError) as caught:
                session_restore.restore_session({"session": "rrr_live"}, self.base)
        self.assertNotIn(secret, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
