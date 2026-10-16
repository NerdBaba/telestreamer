# Live stream metrics and expected cost — 16 October 2026

## Observed deployment

Read-only Render/relay inspection during the user's live stream, approximately
11:52–11:54 IST. No Render restart, upgrade or source-selection changes made.

- Render Metrics shows **2.31 GB service outbound usage this month**. This is an
  hourly-resolution meter, not instantaneous traffic or total workspace usage.
- Actual CPU and RAM utilization is unavailable on this Free service: Render
  asks for paid compute to display it. Metrics labels the CPU limit 0.15 CPU,
  while Compute labels Free 0.1 CPU; both display 512 MB RAM. These are plan
  labels, not measured utilization. No exact live CPU/RAM number is claimed.
- Compute confirms Free $0/month; 0.5 CPU / 512 MB is $7/month. No upgrade made.
- The relay successfully published Novyny.Live at 11:50:03, then the user selected
  Mysore, published at 11:52:40. The earlier destination-call blocker has cleared.
- A sample of three output HLS segments, 6 seconds, contained 811,972 bytes:
  **1.08263 Mbps**, **0.48718 decimal GB/hour**, H.264 640×360 at 25 fps plus AAC.
  This is a short media sample, not a long-term average or network interface counter.

## Telegram capture distinction

The user clarified that the live channel is **RRR INDIA LIVE HORSE RACE**, our
output channel. Capture.Sources deliberately excludes OutputChatID, and choose
rejects it, to prevent feedback into its own broadcast. The outgoing dashboard
preview reads local remux output; it is not independent playback read back from
Telegram. Viewer playback therefore remains a separate check.

A separate preview probe of FREE LIVE INDIA RACING still failed at stream DC 5
channel metadata, with three-second deferrals logged at 11:52:58–11:53:22. No
playable capture was obtained. This does not establish a failure on every Telegram
source or on the RRR output. No speculative transport changes were deployed.

Automatic mode gives Turbo priority after capture readiness and reuses the
existing output call when switching. Manual Mysore selection prevents automatic
Turbo preemption until Start automatic is selected.

## FFmpeg and bandwidth model

Production uses `-c copy`: compressed packets are remuxed without decoding or
encoding. FFmpeg has no separate per-minute remux service fee here; it runs on
the provisioned host. Compute and network charges still apply. This does not
cover transcoding, scaling or generating multiple bitrate renditions.

Render currently includes **5 GB/month on Hobby**, shared across the workspace,
then charges **$0.15/GB public outbound**. Incoming stream data is not charged.
The upload to Telegram and each private dashboard preview consume Render egress.
Proxying the preview through Cloudflare does not remove Render's origin egress.
Telegram viewers do not each fetch from this relay: one upload goes to Telegram,
which distributes it. More viewers therefore do not multiply relay upload bytes.

For a bitrate B in Mbps, H hours/day, P equivalent continuous preview copies:

```text
media GB/hour = B × 0.45
monthly outbound GB = B × 0.45 × 1.10 × H × 30 × (1 + P)
bandwidth USD = max(0, monthly outbound GB - available allowance GB) × 0.15
total USD = bandwidth USD + monthly compute USD
```

The 10% factor is a budgeting allowance for network overhead, not a measured
protocol-overhead value. HLS and outgoing FLV overhead differ. P assumes previews
run for the same H hours/day; count source and output previews separately if both
are open. Other control traffic, retries, build costs, Worker requests/D1 usage,
taxes and other workspace traffic are excluded. Use the allowance still available
to the workspace rather than subtracting a fresh 5 GB from every service.

At the measured 1.08263 Mbps, one outbound copy is approximately **0.536 GB/hour**
including that budgeting margin. For a fresh month with all 5 GB available:

| Streaming | Preview copies | Monthly outbound | Bandwidth only / Free compute | With $7 compute |
|---|---:|---:|---:|---:|
| 6 h/day | 0 | 96.5 GB | $13.72 | $20.72 |
| 6 h/day | 1 | 192.9 GB | $28.19 | $35.19 |
| 24 h/day | 0 | 385.8 GB | $57.13 | $64.13 |

These are projections, not the present invoice or a promise of uninterrupted
Free-tier service. Free plans have service limitations and may suspend when
quotas are exhausted without a payment method. No plan change was performed.

The dashboard now includes an editable calculator. Its defaults use rounded
1.08 Mbps, 6 h/day, no preview copies, 5 GB allowance, $0.15/GB and $0 compute.
The fields are scenario inputs, not live backend metrics.

## Sources, checked 16 October 2026

- [Render outbound bandwidth](https://render.com/docs/outbound-bandwidth)
- [Render pricing](https://render.com/pricing), also verified against this
  service's logged-in Compute screen.
- [Render Free limits](https://render.com/docs/free)
- [FFmpeg streamcopy documentation](https://www.ffmpeg.org/ffmpeg.html#Streamcopy)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Earlier local stress measurements are in GO_RESTREAM_STRESS_2026-10-16.md; they
exclude Telegram ingest and MediaMTX and are not live Render utilization.
