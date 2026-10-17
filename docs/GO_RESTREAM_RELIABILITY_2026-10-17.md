# HLS, RTMP and Telegram capture follow-up — 17 October 2026

The user reported that the HLS test did not start reliably and the RTMP test
sometimes lagged. The initial VPS logs showed Al Jazeera HLS entering publishing
and then losing its sender after 5–14 seconds. A later instrumented reproduction
reported `timestamp discontinuity or publishing lag`. A later numeric trace measured media advancing 12 seconds in 3.56 seconds of
wall time (8.439 seconds ahead). The input remuxer was consuming an HLS backlog
in a burst and deleting unread local segments ahead of the paced sender. Input
reads are now paced at real time; the five-second stale-output guard remains
enabled for genuine discontinuities or stale publishing.

## Corrections

- **HLS input pacing:** a real burst-input regression produced ten seconds of
  output in 0.1 seconds before the fix, reproducing deletion of unread sender
  segments. Input `-re` pacing now limits that producer to real time. RTMP inputs
  use the same pacing so startup buffers cannot overrun the local HLS window.

- **Manual recovery:** a sender exit put the manually chosen source on the same
  30-second cooldown used to yield from Turbo to a backup. With no alternative
  eligible, the controller closed the output call. Manual choices now retry with
  the existing short backoff and preserve the owned call. Automatic priority and
  fallback behavior remain covered by the controller tests.
- **Cold source startup:** the isolated real HLS pipeline took 12.59–18.19 seconds
  to produce its first output. The application previously gave up at 18 seconds.
  Preparation now permits 22 seconds, still below the 25-second controller
  deadline and retaining the 15-second per-read network timeout. A real FFmpeg
  regression supplies network progress while media discovery takes 19 seconds.
- **RTMP preview lifetime:** the media process expired 30 seconds after the
  initial master request, even while child files were being watched. Valid media
  requests now renew activity. A real FFmpeg test previously stopped the process
  at the idle tick and now keeps it alive while requests are active.
- **Capture decode timing:** MediaMTX logged `DTS is not monotonically
  increasing` on actual Telegram output readback. Eight private diagnostic
  fragments from the public news test contained B-frames and independently
  reset decode offsets, including -80 ms and -462 ms. The earlier blanket-copy
  optimization did not account for that. MP4/MOV with reordered video now uses
  normalization; compatible zero-B-frame video retains stream copy. Probe failure
  chooses normalization. Two decoder/encoder threads and one filter thread bound
  per-fragment work on the two-core VPS. The generated B-frame regression failed
  before the correction and passes after; the zero-B-frame frame-hash test still
  verifies lossless copying. The short news fragments are not committed.
- **Capture bootstrap lifetime:** pending media requests could outlast the
  20-second idle grace and have their own ingest stopped while waiting. Request
  scopes now hold activity through HTTP bootstrap/readiness and controller
  preparation, then release it for normal idle cleanup. A real viewer-manager
  regression verifies both the hold and cleanup after release.
- **Capture recovery:** the old eight-second write timeout checked the clock
  before calling a blocking pipe write. It could never interrupt that write.
  Actual OS pipe write deadlines now bound it. A real blocked-pipe regression
  hung past ten seconds before the fix and now returns a timeout at eight.
- **Failure reporting:** exact static native-sender reasons now reach status
  events. Unknown stderr is discarded with a 256-byte line limit; tests reject
  URLs, stream keys and messages with appended private text.

## Final-build live verification

The fixes were deployed to the HostDZire VPS on 17 October, using the existing
single Telegram session. The backend's SHA-256 was
`c0274082713f2c37c0d616b8cccbf2f6cce0553bf18ec1b8e622ae96ec7214ab`.
The temporary instrumented sender was replaced by the standard native binary.
`go -C go_restream test -race ./...` and `go -C go_restream vet ./...` passed.

- HLS publishing: all 36 samples after initial startup remained live, from
  06:01:29 to 06:03:14 UTC, with no retries or errors. The broadcast continued
  until the deliberate RTMP switch at 06:03:43 UTC.
- Telegram HLS readback: real media appeared 36.34 seconds after the diagnostic
  began, including source startup. During the following 65-second observation,
  30 playlist checks had no empty playlists, HTTP errors or sequence resets.
  Sequence numbers advanced. The last segment decoded 25 frames with no errors;
  no capture muxer crashes were observed.
- HLS publishing with Telegram capture active: 87 Docker resource samples over
  approximately 45 seconds averaged 73.22% of one CPU core, peaking at 102.75%.
  The final backend memory sample was 171.1 MiB; Caddy used 15.77 MiB. That is
  about 37% average utilization of the VPS's two cores. Capture normalization is
  real CPU work; remux-only estimates should not be applied to it.
- RTMP publishing and source preview: the preview continued from 27.61 to
  83.85 seconds of playback, with 1920×1080 video, readiness 4 and no video
  element error. It stayed active beyond the previous 30-second idle cutoff.
  All 40 publishing samples after startup stayed live, from 06:03:44 to
  06:05:41 UTC, with no retries or errors.
- Telegram RTMP readback: ready in 10.15 seconds; the following 65 seconds had
  30 nonempty, successful playlist checks, advancing sequence numbers and no
  resets. The last segment decoded 25 frames without errors; no capture muxer
  crashes were observed.
- RTMP publishing with source preview and Telegram capture active: 87 samples
  averaged 81.68% of one CPU core, peaking at 108.02%; final backend memory was
  120.3 MiB. Caddy used 15.86 MiB. Average backend utilization was about 41% of
  the two-core VPS. These measurements include the active diagnostic readback.

Raw samples and readback results are in
[`stress-results/2026-10-17/reliability`](stress-results/2026-10-17/reliability).
These are short live checks, not a day-long soak or a measurement of viewer
join latency on every Telegram client.

The diagnostic broadcast and source preview were stopped after verification.
The original paused controls were restored, with RWITC and Mysore still selected
as fallbacks. The updated backend remains deployed and healthy.

## Remaining limits

Telegram stream metadata is sent to the indicated stream DC and shared pools
honor server backoff. FREE's stream-DC 5 metadata continued returning repeated
short waits in the initial logs. Its open call does not prove it is transmitting
video. This review does not infer a transport fix from that status or start a
second Telegram client. The deployed session remains on the VPS only.

The isolated original HLS and RTMP pipelines both sustained a local RTMP sink
for 45 seconds, with forward-moving packet timestamps and H.264/AAC. This ruled
out a permanent codec rejection on those public feeds, but a local sink alone
was not treated as proof of Telegram playback. Subsequent HLS Telegram readback
returned real video, decoded 47 frames without errors, and advanced its playlist.

The changes preserve stream copy where safe and add normalization only where
fragment decode order needs it. Some latency remains inherent in upstream HLS
segments and Telegram delivery; the checks do not establish zero-latency output
or guarantee availability of third-party feeds.

An earlier intermediate deployment also saw a media I/O failure and a failed
Telegram output connection after initially publishing HLS. Those did not recur
in the final-build observation above. The short final checks establish recovery
and working media paths, not that intermittent upstream/network failures are
impossible.
