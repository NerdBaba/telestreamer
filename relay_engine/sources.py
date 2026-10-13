"""Source monitor: which feed can actually be streamed right now.

Two sources, checked in priority order:

    1. turbo   — @turbosportslive's broadcast, the primary feed
    2. rwitc   — the official stream, behind an Origin-only signing gate

Turbo is primary because the restream mirrors it: when that channel is live,
the Telegram channel carries the same broadcast. RWITC only fills the gap
while Turbo is quiet, so the channel is not idle between broadcasts.

`rwitc.available` is not a record status flag. A newer meeting can have an empty
``stream_url`` while the last active published player still serves live media.
Meeting metadata and playback discovery are separate; only verified recent
media and a readable segment establish availability.

Turbo liveness comes from the channel's public preview. That is a signal, not
the media: it tells us a broadcast started and roughly when, and the daemon
resolves the actual stream through the authenticated relay.
"""

from __future__ import annotations

import json
import rwitc_live
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from urllib.parse import urljoin

RWITC_API = "https://api.rwitc.com/login"
TURBO_PREVIEW = "https://t.me/s/turbosportslive"

# Shared with the public player client: timestamp age is measured from media.
STALE_AFTER_SECONDS = rwitc_live.STALE_AFTER_SECONDS


@dataclass
class SourceStatus:
    name: str
    available: bool
    reason: str
    lag_seconds: float | None = None
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def _get(url: str, headers: dict | None = None, timeout: float = 25.0):
    req = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(req, timeout=timeout)


def _get_json(url: str, headers: dict | None = None, timeout: float = 25.0):
    with _get(url, headers, timeout) as resp:
        return json.loads(resp.read().decode() or "null")


def _get_text(url: str, headers: dict | None = None, timeout: float = 25.0) -> str:
    with _get(url, headers, timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _cookie(signing: dict) -> str:
    return (
        f"CloudFront-Key-Pair-Id={signing['keyPairId']}; "
        f"CloudFront-Policy={signing['encodedPolicy']}; "
        f"CloudFront-Signature={signing['encodedSignature']}"
    )


def stream_records() -> list[dict]:
    """All public meeting/player records, or an empty list on upstream failure."""
    try:
        return rwitc_live.parse_stream_records(_get_json(f"{RWITC_API}/stream"))
    except Exception:
        return []


def stream_record() -> dict | None:
    """Today's IST meeting metadata, independently of playback availability."""
    return rwitc_live.latest_record(stream_records(), today=True)


def playback_record() -> dict | None:
    """Latest active nonempty published player; its media still needs probing."""
    return rwitc_live.latest_record(stream_records(), published=True)


def _player(record: dict) -> tuple[str, str]:
    player = urljoin(rwitc_live.API + "/", record["stream_url"].strip())
    return rwitc_live.player_references(_get_text(player), player)


def signing_cookies(record: dict | None = None) -> dict | None:
    """Resolve signing from an explicit player, or the latest playback candidate."""
    record = record if record is not None else playback_record()
    if not record:
        return None
    try:
        lambda_url, _ = _player(record)
        payload = _get_json(lambda_url, {"Origin": rwitc_live.ORIGIN})
        if isinstance(payload, dict) and payload.get("status") == "success":
            _cookie(payload)  # Reject incomplete signing before probing media.
            return payload
    except Exception:
        pass
    return None


def probe_hls(master_url: str, cookie: str) -> tuple[bool, float | None, str]:
    """Probe a dynamically resolved playlist and newest segment.

    Returns (is_live, lag_seconds, detail). Missing/invalid/future timestamps,
    ended or stale media, and failed segment requests are never live.
    """
    headers = {"Cookie": cookie}
    try:
        master = _get_text(master_url, headers)
        if not master.lstrip().startswith("#EXTM3U"):
            return False, None, "master is not HLS"
        if "#EXTINF:" in master:
            media_url, media = master_url, master
        else:
            variants = rwitc_live.playlist_urls(master, master_url)
            if not variants:
                return False, None, "no variant in master"
            media_url = variants[0]
            media = _get_text(media_url, headers)
        lag = rwitc_live.media_lag(media, datetime.now(timezone.utc))
        if lag is None:
            return False, None, "no valid live segment timestamp"
        if lag > STALE_AFTER_SECONDS:
            return False, lag, f"stale media: lag {lag:.0f}s"
        segment_url = rwitc_live.playlist_urls(media, media_url)[-1]
        with _get(segment_url, headers) as response:
            if not response.read(1):
                return False, lag, "live media segment is empty"
        return True, lag, f"lag {lag:.0f}s"
    except Exception as exc:
        return False, None, f"media probe failed: {exc}"


def check_rwitc() -> SourceStatus:
    rows = stream_records()
    meeting = rwitc_live.latest_record(rows, today=True)
    candidate = rwitc_live.latest_record(rows, published=True)
    if candidate is None:
        return SourceStatus("rwitc", False, "no active published player")

    detail = (f"meeting_venue={meeting.get('venue_name') if meeting else None}; "
              f"player_venue={candidate.get('venue_name')}; "
              f"player_date={candidate.get('race_date')}")
    try:
        lambda_url, master_url = _player(candidate)
        signing = _get_json(lambda_url, {"Origin": rwitc_live.ORIGIN})
        if not isinstance(signing, dict) or signing.get("status") != "success":
            return SourceStatus("rwitc", False, "signing lambda refused", detail=detail)
        cookie = _cookie(signing)
    except Exception as exc:
        return SourceStatus("rwitc", False, f"player discovery failed: {exc}", detail=detail)
    live, lag, reason = probe_hls(master_url, cookie)
    return SourceStatus("rwitc", live, reason, lag, detail)


def check_turbo(live_state: dict | None) -> SourceStatus:
    """Turbo availability, from the preview watcher's derived state.

    `live_state` is what turbo_events.report() returns: live bool, since, and
    the last event. That is a broadcast signal, and the relay is what turns it
    into media. Kept separate so the monitor never touches the TT session.
    """
    if not live_state or not live_state.get("live"):
        return SourceStatus("turbosportslive", False, "not broadcasting")

    return SourceStatus(
        "turbosportslive", True,
        f"live since {live_state.get('since') or 'unknown'}",
        detail=f"last event: {live_state.get('event')}",
    )


def resolve(live_state: dict | None, forced: str | None = None) -> dict:
    """Decide which source should play now.

    Priority is Turbo then RWITC. Turbo is the primary feed the restream is
    built around: while it broadcasts, nothing else is substituted, because
    the channel restream is meant to mirror it exactly. RWITC is the fallback
    when Turbo is quiet, so the channel is not silent between broadcasts.

    An admin override sits on top of both. This function stays pure so the
    arbitration can be tested without a Telegram session.
    """
    rwitc = check_rwitc()
    turbo = check_turbo(live_state)

    if forced in ("rwitc", "turbosportslive"):
        chosen = rwitc if forced == "rwitc" else turbo
        return {
            "chosen": forced,
            "forced": True,
            "available": chosen.available,
            "reason": f"admin forced {forced}; {chosen.reason}",
            "sources": {"rwitc": rwitc.as_dict(),
                        "turbosportslive": turbo.as_dict()},
        }

    chosen = turbo if turbo.available else rwitc
    return {
        "chosen": chosen.name if chosen.available else None,
        "forced": False,
        "available": chosen.available,
        "reason": (
            "turbo live" if turbo.available
            else "rwitc healthy" if rwitc.available
            else f"no source: turbo={turbo.reason} | rwitc={rwitc.reason}"
        ),
        "sources": {"rwitc": rwitc.as_dict(),
                    "turbosportslive": turbo.as_dict()},
    }


if __name__ == "__main__":
    print(json.dumps(resolve(None), indent=2, default=str))
