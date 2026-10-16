# Go stream desk verification — 2026-10-16

Branch: `codex/go-auto-restream`. Application: `go_restream/`.

Passed locally on macOS:

- `go test -race ./...`: all retained TGTV packages and 27 new restream tests.
  New tests cover Turbo priority, fallback eligibility, output exclusion,
  pinned unavailable source, end/pause/restart behavior, failure cooldown,
  startup deadline, FloodWait delay, ownership recovery and unrelated-call
  protection, source metadata isolation, native/scheduled call rejection,
  RWITC signing/freshness, private state, auth/CSRF, preview URL rewriting,
  status credential redaction and offline session conversion.
- `go vet ./...` and JavaScript syntax validation.
- Native macOS build and statically linked Linux amd64 cross-build.
- Existing C RTMP sender compiled against installed FFmpeg libraries.
- Four-second local media round trip: generated live HLS → native sender →
  localhost RTMP receiver → saved FLV. FFprobe confirmed H.264 960×540 and AAC,
  duration 4.010 seconds. Receiver intentionally stopped after four seconds;
  sender's subsequent connection-closed diagnostic was expected.
- Offline SQLite exporter: format, mode 0600, refusal to overwrite, all using
  a synthetic session. Go importer loaded through gotd's real session loader.
- Compose schema/config validation, using a temporary override making the
  absent production `.env` optional. No real environment secrets supplied.
- In-app browser at mobile and desktop widths: sign-in, playing outgoing and
  input videos simultaneously, enabling a fallback, Turbo → fallback,
  pause/resume, persisted pause after process restart, all-offline → idle,
  and automatic restart. Actual video currentTime advanced at 960×540.
  Screenshot: `docs/screenshots/go-streamdesk-demo.jpg`.

Production media validation remains incomplete. The local demo and RTMP round
trip exercise generated media; they do not prove Telegram viewer playback.
The local Docker engine remains unavailable; Render has now built the actual
Linux Docker image successfully.

## Hosted deployment preparation

- Added encrypted D1 controls/owned-call storage and a single-holder lease.
  Go renews every 15 seconds and disconnects if renewal fails. Raw JSON preserves
  Telegram int64 call identities exactly through Workers storage.
- Full Go race suite and vet passed after the hosting changes; Linux amd64
  cross-build passed. Worker TypeScript check passed.
- Applied only additive migration `0002_streamdesk_state.sql` to the existing
  D1 database. Legacy migration 0001 was already applied outside migration
  tracking and must not be blindly re-applied.
- Render's Docker service `telestreamer` (`srv-db87tru89jmc73cipcgg`) now runs
  the combined Go application from branch `codex/go-auto-restream`, backend
  commit `98e7ea4`, at `https://telestreamer-unhc.onrender.com`.
- Successfully cut over the existing relay session after stopping its previous
  holder. Export/import were offline. No local Telegram connection was opened.
  The hosted Go client authenticated and discovered the account's broadcasts.
- Frontend enabled at `https://rwitc-racing.curos282.workers.dev/`, Worker
  version `c1c5531e-a22e-41b5-9764-a92f6a7259de`. Includes the other chat's
  Mysore resolver and both `/mysore/live` and `/api/mysore/live` routes.
- Corrected the existing public status/player adapter to use Go `/api/status`
  and authenticated `/output/` paths, including `s<number>.ts` segments.
  The fixtures endpoint continues reading the official calendar with Go active.
- Full Worker suite: 72/72 passed, TypeScript check passed. A regression test
  failed before the adapter correction and passed afterward. The test covers
  authoritative pause, server-only media authorization, playlist rewriting and
  segment playback against a local HTTP fixture.
- Dashboard browser check: signed in, connected, correct output channel,
  official fallback switches and durable controls. Source-preview failures now
  remain visible across the two-second status refresh.
- Live API checks after Worker deployment: public `/api/stream-status` reports
  paused Go state; `/live/index.m3u8` returns 503 `relay paused` rather than
  bypassing pause with official HLS. Mysore status returns `live:false` and both
  playback routes return 503 `no active stream for today`.

## Actual Telegram capture test — incomplete

- Turbo was offline. The FREE member channel reported an open RTMP broadcast.
- Selecting FREE through the deployed dashboard exercised the real controller.
  Capture failed before destination creation; the event log records
  `source capture could not start`. No successful output broadcast or independent
  Telegram viewer playback was observed.
- Render logs identify `phone.getGroupCallStreamChannels` on stream DC 5 as the
  failing boundary. Every RPC returned `FLOOD_WAIT_3`, including after honoring
  the server's three-second wait. It was not an authorization-export failure.
- Fixed an independently reproduced backoff bug: the same-primary-DC pool path
  previously bypassed the recorded wait, and bootstrap retried after only
  500 milliseconds. A fake-invoker test failed with two RPCs before the wait
  elapsed; it now passes with one RPC and an unchanged deadline. This correction
  did **not** resolve the production metadata failure.
- The existing independent HF capture returned a top-level HLS playlist for
  FREE, but its nested media playlist returned 503. This does not establish
  whether the cause is source media, Telegram routing or another capture issue.
  Do not equate an open Telegram call or an HLS master response with playback.
- Next diagnostic: compare media endpoint selection with Telegram Desktop's
  `groupCallStreamDcId` / `DcType::MediaCluster` path. Existing TGTV code uses
  gotd `Pool` for a primary-DC stream and `DC` for a remote stream, both resolving
  regular endpoints. Desktop prefers media-only endpoints when available.
  This is a hypothesis, not a verified fix; same-DC authorization/session
  reuse must remain correct before changing it. References:
  https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/mtproto/facade.h
  https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp
  https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/calls/group/calls_group_call.cpp

Current durable controls: `auto:true`, `paused:true`, `forced:""`,
`fallbacks:["rwitc","mysore"]`. Turbo remains first automatically; the FREE
member feed is no longer enabled as a fallback after the test.

## Hosting constraints and safe redeploys

- Current Render free instance advertises 0.15 CPU and 512 MB RAM. No plan
  upgrade was made. CPU/RAM usage charts are unavailable on this plan.
- `GOMAXPROCS=1`, `GOMEMLIMIT=256MiB`, maximum two input captures. The Go memory
  target excludes FFmpeg, MediaMTX, the native sender and other container memory.
  Production CPU/RAM remains unmeasured. A subsequent synthetic local relay
  stress test and bounded hosted API bursts are recorded in
  `docs/GO_RESTREAM_STRESS_2026-10-16.md`; those numbers exclude Telegram capture.
- Render's free tier can sleep; the existing Worker cron generates health
  traffic every ten minutes. It is not a production uptime guarantee.
- Render's rolling deployment overlaps old and new containers. Every deployment
  of a session-bearing backend must use two stages: save
  `STREAMDESK_STANDBY=true`, deploy and wait for `/health` to report `standby`;
  then save `STREAMDESK_STANDBY=false`, deploy and wait for `status:ok`.
  Standby starts before session restoration and never connects to Telegram.
  The D1 lease prevents two active Go holders during overlap.
- Render secret values load asynchronously. Wait for the existing value to
  finish loading before editing, or the settings UI can overwrite a freshly
  typed value with the old value. Avoid full environment accessibility
  snapshots: they can disclose hidden textarea values.


## Real public test inputs — 2026-10-16

- Added `test-rtmp`: Novyny.Live,
  `rtmp://95.67.11.153/klive/stream`.
- Added `test-hls`: Al Jazeera English,
  `https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8`.
- Discovered current URLs from the maintained IPTV-org public directory.
  Both contain H.264 video and AAC audio. Four-second direct FFmpeg decode
  passed for each. The public Indexforce RTMP sample also decoded, but was
  not needed as an additional card.
- The suggested Akamai `2000341/test/master.m3u8` returned 404. The Eight
  sample yielded no playable streams and the Blender sample timed out.
  None was added as a supposedly working test source.
- Tests are manual only. The controller excludes both IDs from automatic
  fallbacks even if mistakenly saved in that list. Cards display actual
  public URLs and have no automatic fallback checkbox.
- RTMP preview starts an on-demand `-c copy` remux of the real remote feed to
  private HLS and stops after 30 seconds without preview requests. Outgoing
  publishing reads the original RTMP URL directly. No generated media used.
- Real input → Go preview proxy → FFmpeg decode integration check passed.
  The check exposed FFmpeg's rejection of extensionless HLS segment URLs;
  opaque preview URLs now retain only a recognized media extension, while
  continuing to hide provider paths, signed queries and headers. A failing
  regression test was observed before this correction and passes afterward.
- Go race suite and vet passed. Worker typecheck and all 72 tests passed.
- Render standby deployment `dep-db8rsfei0phs738q4sh0` succeeded, followed by
  active deployment `dep-db8rtlfavr4c73c4i0pg` on backend `98e7ea4`.
  Standby health explicitly confirmed `telegram_connected:false` between
  session-bearing instances. Worker deployed as version
  `c1c5531e-a22e-41b5-9764-a92f6a7259de`, preserving Mysore support.
- Deployed Chrome playback: Novyny RTMP preview readyState 4, 1920×1080,
  currentTime 8.83 seconds and playing. Al Jazeera HLS preview readyState 4,
  1920×1080, currentTime 36.51 seconds and playing. Screenshots:
  `docs/screenshots/public-rtmp-preview.png` and
  `docs/screenshots/public-hls-preview.png`.
- Mysore became fresh/live during verification. Resuming the configured
  automatic racing fallbacks failed before publishing with
  `Telegram destination unavailable; inspect destination call and permissions`.
  No successful outgoing broadcast was observed. The ownership journal is
  absent (404). The native Telegram app shows an existing livestream in the
  RRR channel, but the exact backend failure cause is not yet established.
  The existing call was not discarded. Output was paused again, preserving
  Turbo → RWITC → Mysore settings; both test previews remain usable.
