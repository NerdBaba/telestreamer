#!/usr/bin/env python3
"""Create the MTProto session used by the RRR live stream automation.

Run once, locally. The resulting rrr_live.session file is a sensitive
credential. Automation reuses it until Telegram revokes or expires the
authorization; never share the session file.

    ./.venv/bin/python telegram_login.py \
        --api-id 12345678 \
        --api-hash 0123456789abcdef0123456789abcdef \
        --channels TurboSportsLive,YOUR_CHANNEL

The OTP code and the 2FA password are typed into your own terminal. They never
leave your machine, which also means they stay out of any chat history, tool
output, or log file.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

SESSION_NAME = "rrr_live"
MAX_OTP_ATTEMPTS = 3

# Default read-only source to inspect when no explicit targets are supplied.
DEFAULT_CHANNELS = ("turbosportslive",)


def _supports_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("TERM") not in ("", "dumb")


def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _supports_color() else text


GREEN, YELLOW, RED, BOLD = "1;32", "1;33", "1;31", "1"


def note(msg: str) -> None:
    print(_c(msg, GREEN))


def warn(msg: str) -> None:
    print(_c(msg, YELLOW))


def fail(msg: str) -> None:
    print(_c(msg, RED))


def prompt(label: str, secret: bool = False) -> str:
    """Read one value from the terminal, explaining what to type and why.

    Secrets never echo, which is correct but looks like a frozen prompt, so
    the label says so. A non-interactive stdin cannot receive keystrokes at
    all, so that fails with instructions rather than hanging.
    """
    import getpass
    import sys

    if not sys.stdin.isatty():
        fail("this shell is not interactive, so the code cannot be entered here.")
        note("Run the same command in a normal terminal window, e.g. Terminal.app.")
        raise SystemExit(2)
    if secret:
        note("this one is hidden on purpose; type it, then press Enter.")
        return getpass.getpass(f"{label}: ").strip()
    return input(f"{label}: ").strip()


async def _channel_report(client, username: str) -> dict[str, object] | None:
    """Inspect an existing channel membership without ever joining a chat."""
    from relay_engine.telegram import TelegramAccessError, resolve_channel

    try:
        entity, full = await resolve_channel(client, username)
    except TelegramAccessError as exc:
        warn(f"  could not resolve requested channel: {exc}")
        return None
    except Exception as exc:
        warn(f"  could not resolve requested channel ({type(exc).__name__})")
        return None

    return {
        "username": getattr(entity, "username", None) or f"id{entity.id}",
        "id": entity.id,
        "title": getattr(entity, "title", ""),
        "broadcast": bool(getattr(entity, "broadcast", False)),
        "creator": bool(getattr(entity, "creator", False)),
        "manage_call": bool(getattr(getattr(entity, "admin_rights", None),
                                   "manage_call", False)),
        "active_call": getattr(full.full_chat, "call", None) is not None,
    }


def _print_table(rows: list[dict[str, object]]) -> None:
    header = ("username", "title", "broadcast", "creator", "manage_call", "call now")
    widths = [max(len(str(r.get(h, ""))) for r in rows + [dict(zip(header, header))])
              for h in header]
    line = "  ".join(h.ljust(w) for h, w in zip(header, widths))
    print(_c(line, BOLD))
    print(_c("-" * len(line), BOLD))
    for r in rows:
        cells = [
            str(r["username"]).ljust(widths[0]),
            str(r["title"])[:22].ljust(widths[1]),
            _c(str(r["broadcast"]), "32" if r["broadcast"] else "31").ljust(widths[2] + 4),
            _c(str(r["creator"]), "32" if r["creator"] else "31").ljust(widths[3] + 4),
            _c(str(r["manage_call"]), "32" if r["manage_call"] else "31").ljust(widths[4] + 4),
            _c(str(r["active_call"]), "33" if r["active_call"] else "2").ljust(widths[5] + 4),
        ]
        print("  ".join(cells))


async def _login(client, phone: str) -> bool:
    """Authenticate, prompting for the OTP code and 2FA locally."""
    for attempt in range(1, MAX_OTP_ATTEMPTS + 1):
        try:
            await client.send_code_request(phone)
        except Exception as exc:
            fail(f"could not send the login code ({type(exc).__name__})")
            return False

        code = prompt(f"Telegram login code (attempt {attempt})", secret=False)
        try:
            await client.sign_in(phone=phone, code=code)
            return True
        except Exception as exc:
            name = type(exc).__name__
            if name == "SessionPasswordNeededError":
                password = prompt("2FA password", secret=True)
                try:
                    await client.sign_in(password=password)
                    return True
                except Exception as pw_exc:
                    fail(f"2FA password rejected ({type(pw_exc).__name__})")
                    return False
            if name == "PhoneCodeInvalidError":
                warn("that code was not accepted. Check it and try again.")
                continue
            if name == "PhoneCodeExpiredError":
                warn("that code expired. Requesting a fresh one.")
                continue
            fail(f"login failed ({type(exc).__name__})")
            return False

    fail("too many rejected codes. Re-run the script.")
    return False


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Create the MTProto session for the RRR live relay.")
    ap.add_argument("--api-id", type=int, required=True,
                    help="api_id from my.telegram.org")
    ap.add_argument("--api-hash", required=True,
                    help="api_hash from my.telegram.org")
    ap.add_argument("--channels", default=",".join(DEFAULT_CHANNELS),
                    help="comma-separated usernames, private invite links, or known channel ids to verify")
    ap.add_argument("--session", default=SESSION_NAME,
                    help=f"session file name (default {SESSION_NAME})")
    return ap.parse_args(argv)


async def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    from pathlib import Path
    from telethon import TelegramClient

    print()
    print(_c("RRR live relay — Telegram session setup", BOLD))
    print("If login is needed, your phone number, login code, and 2FA password")
    print("are entered only in this terminal. No channels are joined automatically.")
    print()

    session_path = Path(args.session).expanduser()
    if not str(session_path).endswith(".session"):
        session_path = Path(str(session_path) + ".session")
    client = TelegramClient(str(session_path), args.api_id, args.api_hash)
    try:
        await client.connect()
        authorized = await client.is_user_authorized()
        if not authorized:
            phone = prompt("phone number (international format, e.g. +91...)", secret=False)
            if not await _login(client, phone):
                return 1

        me = await client.get_me()
        note(f"signed in as @{me.username or me.first_name} (id {me.id})")
        note(f"session saved to {session_path.resolve()}")

        wanted = [c.strip() for c in args.channels.split(",") if c.strip()]
        print()
        note("verifying requested channels ...")
        rows = []
        for username in wanted:
            report = await _channel_report(client, username)
            if report:
                rows.append(report)

        if rows:
            print()
            _print_table(rows)
            print()
            for r in rows:
                if not (r["creator"] or r["manage_call"]):
                    warn(f"@{r['username']}: read-only for livestream management.")
                    warn("  Publishing here requires creator or manage-call admin rights.")
        else:
            warn("no channels could be resolved. Check membership and the requested targets.")

        print()
        note("Keep the session file private. The table above contains no session or RTMP secrets.")
        return 0 if rows and len(rows) == len(wanted) else 1
    finally:
        await client.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
