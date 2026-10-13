"""Deterministic relay regression tests: no network or credentials required."""

from __future__ import annotations

import io
import json
import sys
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rwitc_live  # noqa: E402
from relay_engine import fixtures, sources, turbo_events  # noqa: E402

NOW = datetime(2030, 4, 15, 9, 0, tzinfo=timezone.utc)
PLAYER = "https://api.rwitc.com/player/punelive_code.html"
LAMBDA = "https://example.lambda-url.ap-south-1.on.aws/"
MASTER = "https://cfs.rwitc.com/rotatedToken/index.m3u8"
MEDIA = "https://cfs.rwitc.com/rotatedToken/720p/playlist.m3u8"
SEGMENT = "https://cfs.rwitc.com/rotatedToken/720p/last.ts"
SIGNING = {"status": "success", "keyPairId": "key", "encodedPolicy": "policy",
           "encodedSignature": "signature"}


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


def record(day="2030-04-15", url=PLAYER, status="active", venue="PUNE"):
    return {"race_date": day, "venue_name": venue, "status": status,
            "paid_status": "free", "iframe_flag": "yes", "stream_url": url}


def media(stamp="2030-04-15T08:59:45Z", segment="last.ts", ended=False):
    return ("#EXTM3U\n#EXT-X-TARGETDURATION:10\n"
            f"#EXT-X-PROGRAM-DATE-TIME:{stamp}\n#EXTINF:10,\n{segment}\n"
            + ("#EXT-X-ENDLIST\n" if ended else ""))


@contextmanager
def offline(responses=None):
    """Patch the transport, not discovery; unknown URLs fail closed."""
    responses = responses or {}

    def urlopen(request, timeout=None):
        url = request.full_url if isinstance(request, urllib.request.Request) else request
        if url not in responses:
            raise AssertionError(f"Unexpected network request: {url}")
        value = responses[url]
        if isinstance(value, Exception):
            raise value
        if url == LAMBDA:
            assert request.get_header("Origin") == "https://api.rwitc.com"
        if url.startswith("https://cfs.rwitc.com/"):
            assert "CloudFront-Signature=signature" in request.get_header("Cookie", "")
        if isinstance(value, (dict, list)):
            value = json.dumps(value)
        return io.BytesIO(value.encode() if isinstance(value, str) else value)

    with patch("urllib.request.urlopen", side_effect=urlopen), \
            patch.object(sources, "datetime", FrozenDatetime), \
            patch.object(rwitc_live, "datetime", FrozenDatetime), \
            patch.object(fixtures, "datetime", FrozenDatetime), \
            patch.object(turbo_events, "datetime", FrozenDatetime):
        yield


def feed(rows=None, playlist=None, variant="720p/playlist.m3u8", master=MASTER):
    return {
        rwitc_live.STREAM_RECORD: {"data": rows if rows is not None else [record()]},
        PLAYER: f"<script>fetch('{LAMBDA}'); const source = '{master}';</script>",
        LAMBDA: SIGNING,
        master: f"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n{variant}\n",
        MEDIA: playlist if playlist is not None else media(),
        SEGMENT: b"live segment bytes",
    }


def test_placeholder_dates_dropped():
    rows = [{"start": "0000-00-00", "title": "Mumbai"},
            {"start": "2099-01-01", "title": "Future"}]
    with offline({fixtures.CALENDAR_URL: {"data": rows}}):
        assert fixtures.fetch_meetings() == []


def test_meeting_within_horizon_kept():
    with offline({fixtures.CALENDAR_URL: {
            "data": [{"start": "2030-04-18", "title": "PUNE"}]}}):
        meetings = fixtures.fetch_meetings()
        assert [meeting.iso for meeting in meetings] == ["2030-04-18"]
        assert meetings[0].title == "PUNE"


def test_active_record_without_any_published_player_is_unavailable():
    with offline(feed(rows=[record(url="")])):
        assert not sources.check_rwitc().available


def test_empty_newest_record_does_not_hide_healthy_previous_player():
    rows = [record("2030-04-14", venue="MUMBAI"), record(url="")]
    with offline(feed(rows)):
        assert sources.stream_record()["venue_name"] == "PUNE"
        assert sources.stream_record()["stream_url"] == ""
        assert sources.playback_record()["venue_name"] == "MUMBAI"
        status = sources.check_rwitc()
        assert status.available, status
        assert status.lag_seconds == 15
        assert rwitc_live.LiveStream.fetch().master_url == MASTER


def test_historical_record_is_not_todays_meeting():
    with offline(feed([record("2030-04-14")])):
        assert sources.stream_record() is None
        assert sources.check_rwitc().available


def test_latest_published_player_respects_token_rotation():
    rotated = "https://cfs.rwitc.com/newToken/index.m3u8?version=2"
    responses = feed(master=rotated)
    responses[PLAYER] = (f'fetch("{LAMBDA}"); '
                         'const source="https://cfs.rwitc.com/newToken/index.m3u8?version=2";')
    responses[rotated] = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n../rotatedToken/720p/playlist.m3u8\n"
    with offline(responses):
        assert sources.check_rwitc().available
        assert rwitc_live.LiveStream.fetch().master_url == rotated


def test_newest_inactive_player_does_not_replace_active_candidate():
    with offline(feed([record(), record(url="https://unused.invalid/", status="inactive")])):
        assert sources.check_rwitc().available


def test_newest_same_day_published_player_is_used():
    earlier = "https://api.rwitc.com/player/old.html"
    with offline(feed([record(url=earlier), record()])):
        assert sources.playback_record()["stream_url"] == PLAYER
        assert sources.check_rwitc().available


def test_variant_url_join_handles_relative_root_absolute_and_spaces():
    variants = ["720p/playlist.m3u8", "/rotatedToken/720p/playlist.m3u8", MEDIA,
                "720p/playlist with spaces.m3u8"]
    for variant in variants:
        responses = feed(variant=variant)
        if "spaces" in variant:
            responses["https://cfs.rwitc.com/rotatedToken/720p/playlist%20with%20spaces.m3u8"] = media()
        with offline(responses):
            assert sources.check_rwitc().available, variant


def test_segment_url_join_and_direct_media_playlist():
    for segment in (SEGMENT, "/rotatedToken/720p/last.ts",
                    "last segment.ts?token=rotated"):
        responses = feed(playlist=media(segment=segment))
        if "token=" in segment:
            responses["https://cfs.rwitc.com/rotatedToken/720p/last%20segment.ts?token=rotated"] = b"live"
        with offline(responses):
            assert sources.check_rwitc().available, segment
    responses = feed()
    responses[MASTER] = media(segment=SEGMENT)
    with offline(responses):
        assert sources.check_rwitc().available
        assert rwitc_live.LiveStream.fetch().master_url == MASTER


def test_stale_future_invalid_and_ended_media_are_not_selected():
    playlists = [media("2030-04-15T08:54:59Z"), media("2030-04-15T09:00:01Z"),
                 media("not-a-date"), media("2030-04-15T08:59:45"),
                 media(ended=True), "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2030-04-15T08:59:45Z\n"]
    for playlist in playlists:
        with offline(feed([record("2030-04-14"), record(url="")], playlist)):
            decision = sources.resolve({"live": True})
            assert decision["chosen"] == "turbosportslive", decision
            assert not decision["sources"]["rwitc"]["available"]


def test_lag_threshold_includes_boundary_and_zero():
    for stamp, lag in (("2030-04-15T08:55:00Z", 300), ("2030-04-15T09:00:00Z", 0)):
        with offline(feed(playlist=media(stamp))):
            status = sources.check_rwitc()
            assert status.available
            assert status.lag_seconds == lag


def test_stale_public_player_client_refuses_playback():
    with offline(feed(playlist=media("2030-04-15T08:54:59Z"))):
        try:
            rwitc_live.LiveStream.fetch()
        except RuntimeError:
            pass
        else:
            raise AssertionError("Stale media must not be offered as a live stream")


def test_latest_program_date_time_is_used_for_live_lag():
    playlist = ("#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2030-04-15T08:00:00Z\n"
                "#EXTINF:10,\nold.ts\n#EXT-X-PROGRAM-DATE-TIME:2030-04-15T08:59:45Z\n"
                "#EXTINF:10,\nlast.ts\n")
    with offline(feed(playlist=playlist)):
        status = sources.check_rwitc()
        assert status.available
        assert status.lag_seconds == 15


def test_failed_player_signing_master_variant_or_segment_is_unavailable():
    for url in (rwitc_live.STREAM_RECORD, PLAYER, LAMBDA, MASTER, MEDIA, SEGMENT):
        responses = feed()
        responses[url] = urllib.error.HTTPError(url, 503, "unavailable", {}, None)
        with offline(responses):
            assert not sources.check_rwitc().available, url
    for payload in ({"data": None}, {"data": "bad rows"}, None):
        responses = feed()
        responses[rwitc_live.STREAM_RECORD] = json.dumps(payload)
        with offline(responses):
            assert not sources.check_rwitc().available
    for url, value in ((LAMBDA, {"status": "success", "keyPairId": "key"}),
                       (LAMBDA, {"status": "denied"}),
                       (PLAYER, "<html>No player published</html>"),
                       (MASTER, "<html>upstream error</html>"),
                       (SEGMENT, b"")):
        responses = feed()
        responses[url] = value
        with offline(responses):
            assert not sources.check_rwitc().available


def test_priority_prefers_turbo_then_rwitc():
    with offline(feed()):
        assert sources.resolve({"live": True})["chosen"] == "turbosportslive"
    with offline(feed([record(url="")])):
        decision = sources.resolve({"live": False})
        assert decision["chosen"] is None
        assert not decision["available"]
        assert sources.resolve({"live": True})["chosen"] == "turbosportslive"


def test_admin_override_wins_even_if_forced_source_is_unavailable():
    with offline(feed()):
        decision = sources.resolve({"live": False}, forced="turbosportslive")
        assert decision["forced"] is True
        assert decision["chosen"] == "turbosportslive"
        assert not decision["available"]
    with offline(feed([record(url="")])):
        decision = sources.resolve({"live": True}, forced="rwitc")
        assert decision["forced"] is True
        assert decision["chosen"] == "rwitc"
        assert not decision["available"]
        assert sources.resolve({"live": True}, forced="invalid")["chosen"] == "turbosportslive"


def preview(event, stamp, post="2299"):
    return f'''<div class="tgme_widget_message_wrap js-widget_message_wrap">
<div class="tgme_widget_message service_message js-widget_message" data-post="TurboSportsLive/{post}">
<div class="tgme_widget_message_text js-message_text">Live stream {event}</div>
<time datetime="{stamp}" class="time">09:00</time></div></div>'''


def test_turbo_live_from_preview():
    with offline({turbo_events.PREVIEW_URL: preview("started", "2030-04-15T08:00:00+00:00")}):
        state = turbo_events.live_state()
        assert state["live"] is True
        assert state["event"] == "started"
        assert state["post_id"] == "2299"
        assert state["since"] == "2030-04-15T08:00:00+00:00"


def test_turbo_finished_means_off():
    with offline({turbo_events.PREVIEW_URL: preview("finished (3 hours)", "2030-04-15T08:00:00+00:00")}):
        state = turbo_events.live_state()
        assert state["live"] is False
        assert state["event"] == "finished"


def test_stale_started_is_not_live():
    with offline({turbo_events.PREVIEW_URL: preview("started", "2030-04-06T08:00:00+00:00")}):
        state = turbo_events.live_state()
        assert state["live"] is False
        assert state.get("inferred")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  PASS  {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {test.__name__}: {exc}")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {test.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
