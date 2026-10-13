"""Race fixtures: which meetings are on, and when.

Source of truth is the RWITC public calendar API. It needs no credentials and
no a session, so fixture state stays correct even if the Turbo session dies.

The calendar has two quirks that are handled here:

* Many rows carry ``start: "0000-00-00"`` (placeholder entries). Parsing those
  as dates raises, so they are dropped.
* The calendar lists meetings across many venues, not just RWITC. The relay
  treats any of them as a race window, because Turbo broadcasts all of them.
"""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

CALENDAR_URL = "https://www.rwitc.com/rwitc_website_api/fetchCalendar_get_api.php"
RACECARD_URL = "https://api.rwitc.com/login/data/raw_racecard.json"
IST_OFFSET = timedelta(hours=5, minutes=30)
CACHE_PATH = "fixtures_cache.json"


def today_ist() -> date:
    """Current date at the venue. The calendar and the race times are IST."""
    return datetime.now(timezone.utc) + IST_OFFSET


def _valid_date(raw: str) -> date | None:
    try:
        parsed = datetime.strptime(raw, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None
    return parsed if parsed.year > 1 else None


@dataclass(frozen=True)
class Meeting:
    date: date
    title: str

    @property
    def iso(self) -> str:
        return self.date.isoformat()

    @property
    def weekday(self) -> str:
        return self.date.strftime("%a")


def _get_json(url: str, timeout: float = 20.0):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "null")


def fetch_meetings(days: int = 14) -> list[Meeting]:
    """Upcoming race meetings, nearest first, within `days` of today IST."""
    try:
        payload = _get_json(CALENDAR_URL)
    except Exception:
        return []
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not rows:
        return []

    start = today_ist().date()
    horizon = start + timedelta(days=days)
    seen: set[str] = set()
    out: list[Meeting] = []
    for row in rows:
        day = _valid_date(row.get("start", ""))
        if day is None or not (start <= day <= horizon):
            continue
        key = f"{day.isoformat()}|{row.get('title', '')}"
        if key in seen:
            continue
        seen.add(key)
        out.append(Meeting(day, row.get("title") or "Racing"))
    return sorted(out, key=lambda m: m.date)


def fetch_racecard() -> dict:
    """Today's raw race card, or an empty dict when none is published.

    This is the same free endpoint the race card API serves. `streamUrl` is
    null whenever RWITC has not published the link, which is the primary
    source's "not available" signal.
    """
    try:
        return _get_json(RACECARD_URL) or {}
    except Exception:
        return {}


def next_meeting(meetings: list[Meeting]) -> Meeting | None:
    return meetings[0] if meetings else None


def cache_meetings(meetings: list[Meeting], path: str = CACHE_PATH) -> None:
    """Persist so a restarted daemon starts with a known schedule."""
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "meetings": [{"date": m.iso, "title": m.title} for m in meetings],
    }
    try:
        with open(path, "w") as fh:
            json.dump(payload, fh)
    except OSError:
        pass


def load_cached_meetings(path: str = CACHE_PATH) -> list[Meeting]:
    try:
        with open(path) as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    out = []
    for row in payload.get("meetings", []):
        day = _valid_date(row.get("date", ""))
        if day:
            out.append(Meeting(day, row.get("title", "Racing")))
    return out


def is_race_today() -> bool:
    """True when a meeting is scheduled for today IST."""
    card = fetch_racecard()
    return bool(card.get("races")) and bool(card.get("raceDate"))


if __name__ == "__main__":
    upcoming = fetch_meetings()
    cache_meetings(upcoming)
    print(f"today (IST): {today_ist().date()}")
    if not upcoming:
        print("no meetings in the next 14 days")
    for m in upcoming:
        print(f"  {m.iso} {m.weekday}  {m.title}")
    card = fetch_racecard()
    print(f"\ntoday's card: {card.get('raceDate')} {card.get('venueName')} "
          f"| races: {len(card.get('races') or [])} | streamUrl: {card.get('streamUrl')!r}")
