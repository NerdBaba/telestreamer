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
- **Capture recovery:** the old eight-second write timeout checked the clock
  before calling a blocking pipe write. It could never interrupt that write.
  Actual OS pipe write deadlines now bound it. A real blocked-pipe regression
  hung past ten seconds before the fix and now returns a timeout at eight.
- **Failure reporting:** exact static native-sender reasons now reach status
  events. Unknown stderr is discarded with a 256-byte line limit; tests reject
  URLs, stream keys and messages with appended private text.

## Review limits

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
