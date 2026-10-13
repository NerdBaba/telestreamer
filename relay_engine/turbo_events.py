"""Turbo broadcast detector.

Polls the public channel preview. No credentials, no TT session, and it never
joins the video chat, so it cannot expose your identity to Turbo members.

It answers one question: is @turbosportslive broadcasting a livestream right
now? That is the trigger for the daemon to fetch, and it is deliberately kept
separate from the media, which the authenticated relay handles.

The preview's "Live stream started" and "Live stream finished" service messages
are the reliable signal, because Turbo posts them for every broadcast. The last
one wins, and the timestamp tells us how long the current one has run.
"""

from __future__ import annotations

import html
import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone

PREVIEW_URL = "https://t.me/s/turbosportslive"
STARTED = re.compile(r"Live stream started", re.I)
FINISHED = re.compile(r"Live stream finished", re.I)

# A broadcast cannot plausibly run longer than this. The public preview keeps
# about 20 posts, so an old "started" whose "finished" scrolled off the page
# must not be mistaken for a live stream.
STREAM_MAX_RUNNING_SECONDS = 6 * 3600
TAG_RE = re.compile(r"<[^>]+>")


def _fetch(url: str, timeout: float = 25.0) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; rrr-relay/1.0)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _parse_page(page_html: str) -> list[dict]:
    """Split the preview into messages, newest first.

    Real markup: each message is a `tgme_widget_message_wrap` div containing a
    `tgme_widget_message` with `data-post="TurboSportsLive/2203"`, and a
    `<time datetime="2026-10-02T08:12:51+00:00">` tag further down.
    """
    blocks = re.split(r'<div class="tgme_widget_message_wrap', page_html)[1:]
    out = []
    for block in blocks:
        id_match = re.search(r'data-post="[^/]+/(\d+)"', block)
        time_match = re.search(r'<time[^>]*datetime="([^"]+)"', block)
        text = TAG_RE.sub(" ", block)
        text = html.unescape(re.sub(r"\s+", " ", text)).strip()
        out.append({
            "id": id_match.group(1) if id_match else "",
            "at": time_match.group(1) if time_match else None,
            "text": text,
        })
    return out


def _parse_time(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def live_state(url: str = PREVIEW_URL) -> dict:
    """Derive whether a broadcast is running right now.

    Resolves the newest started/finished pair. A `finished` with a higher post
    id than the newest `started` means no broadcast is running.
    """
    try:
        page = _fetch(url)
    except Exception as exc:
        return {"live": False, "error": str(exc), "since": None, "event": None}

    messages = _parse_page(page)
    newest_started = newest_finished = None

    for msg in messages:
        if newest_started is None and STARTED.search(msg["text"]):
            newest_started = msg
        if newest_finished is None and FINISHED.search(msg["text"]):
            newest_finished = msg
        if newest_started and newest_finished:
            break

    def newer(a, b) -> bool:
        if not a:
            return False
        if not b:
            return True
        try:
            return int(a["id"] or 0) > int(b["id"] or 0)
        except ValueError:
            return False

    if newest_started and newer(newest_started, newest_finished):
        started_at = _parse_time(newest_started["at"])
        running = (
            (datetime.now(timezone.utc) - started_at).total_seconds()
            if started_at else None)

        # A started with no newer finished normally means "broadcasting now".
        # But the preview only carries about 20 posts, so if the newest started
        # is old, its finished was pushed off the page. Treat it as over rather
        # than reporting a stream running for days, which is impossible.
        if running is not None and running > STREAM_MAX_RUNNING_SECONDS:
            return {
                "live": False,
                "since": newest_started["at"],
                "event": "finished",
                "post_id": newest_started["id"],
                "running_for_seconds": running,
                "inferred": "started aged out of the preview window",
            }

        return {
            "live": True,
            "since": newest_started["at"],
            "event": "started",
            "post_id": newest_started["id"],
            "running_for_seconds": running,
        }

    return {
        "live": False,
        "since": None,
        "event": "finished" if newest_finished else None,
        "post_id": newest_finished["id"] if newest_finished else None,
        "last_finished_at": newest_finished["at"] if newest_finished else None,
    }


def running_for_human(state: dict) -> str:
    secs = state.get("running_for_seconds")
    if not secs:
        return "unknown"
    secs = int(secs)
    return f"{secs // 3600}h {(secs % 3600) // 60}m" if secs >= 3600 else f"{secs // 60}m"


if __name__ == "__main__":
    print(json.dumps(live_state(), indent=2, default=str))
