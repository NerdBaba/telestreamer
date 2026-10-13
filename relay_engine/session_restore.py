"""Restore an authorized Telegram session from an environment base64 secret.

A hosted container starts with an empty filesystem, so the session file that
``telegram_login.py`` wrote locally cannot simply be copied into the image: the
account is authorized only once, and baking a credential into a public image
would expose it. Instead the base64 payload is stored as a private secret and
materialized at startup with owner-only permissions.

The payload is validated before it is written, so a truncated or corrupted
secret fails at startup instead of producing a session that cannot publish:

* base64 must round-trip exactly,
* the bytes must be an SQLite image containing the Telethon tables,
* ``PRAGMA integrity_check`` must report ``ok``.

Two to three lost bytes can still slip through, because SQLite stores them in
an unused page and reports no damage. That is undetectable without a trusted
length or checksum, so a restored session is only as trustworthy as the secret
it came from. Reporting a failure is preferred over silently publishing with a
broken credential.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

SQLITE_MAGIC = b"SQLite format 3\x00"
MIN_SESSION_BYTES = 1024


def restore_session(config: dict, base: Path) -> Path:
    """Return the session path, restoring it from the environment if needed.

    A local session file wins, so local development never needs the secret.
    On a host the payload is written next to the configured session name,
    because Telethon appends ``.session`` itself.
    """
    raw = os.environ.get("TELEGRAM_SESSION_B64")
    if raw is None:
        return Path(base) / str(config.get("session", "rrr_live"))
    if not raw.strip():
        # A variable that exists but is empty is a misconfiguration, not an
        # absence: silently falling back to the local path would publish with
        # no session and fail later with a confusing error.
        raise RuntimeError("TELEGRAM_SESSION_B64 is set but empty")
    target = Path(base) / str(config.get("session", "rrr_live"))
    if target.with_suffix(".session").exists():
        return target
    try:
        payload = base64.b64decode(raw, validate=True)
        if base64.b64encode(payload).decode("ascii") != raw:
            raise ValueError("base64 payload is not exactly decodable")
        head = payload.lstrip()[:1]
        is_json = head in (b"{", b"[")
        if not is_json and not payload.startswith(SQLITE_MAGIC):
            raise ValueError("payload is neither an SQLite session nor a JSON export")
        if is_json:
            json.loads(payload.decode("utf-8", "replace"))
        else:
            # A truncated base64 payload can still decode to a valid SQLite
            # prefix, so open the image before trusting it.
            import sqlite3
            import tempfile
            handle, probe_name = tempfile.mkstemp(suffix=".session")
            try:
                with os.fdopen(handle, "wb") as stream:
                    stream.write(payload)
                connection = sqlite3.connect(f"file:{probe_name}?mode=ro", uri=True)
                try:
                    tables = {row[0] for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'")}
                    if not {"sessions", "entities"} <= tables:
                        raise ValueError("payload is an SQLite file without Telegram session tables")
                    integrity = connection.execute("PRAGMA integrity_check").fetchone()
                    if not integrity or integrity[0] != "ok":
                        raise ValueError("payload is a damaged SQLite database")
                finally:
                    connection.close()
            finally:
                os.unlink(probe_name)
    except Exception as exc:
        raise RuntimeError("TELEGRAM_SESSION_B64 could not be decoded as a Telegram session") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target.with_suffix(".session"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
    return target
