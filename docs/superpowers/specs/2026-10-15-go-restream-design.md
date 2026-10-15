# Single-host Go auto-restream

Extend the bundled AGPL TGTV source at commit 69ddb30949cdeb604820a5d324e01b1b76a7b79a. Capture, discovery, publishing and administration share one authorized gotd client. Existing HF, Render and Worker services remain running until VM cutover. Never connect the active relay session locally.

Turbo chat 2961901881 is primary; destination 4347395930 is excluded. Other discovered RTMP broadcasts appear with explicit automatic fallback eligibility and manual selection. RWITC uses the existing official player/signing flow and recent HLS media validation. Scheduled and native phone calls are ineligible.

A serialized controller reconciles each second, retains its owned destination call across source switches, retries failures with capped backoff, and discards only its own call on pause, idle or shutdown. Persist controls and call identity atomically with private permissions. Reject unrelated destination calls. Failed discovery never implies a confirmed stream end.

One responsive embedded dashboard: outgoing preview, Turbo/RWITC/member cards, clear status labels, persisted controls and recent events. Source previews are opt-in to bound resource use. Authenticated same-origin media routes; viewers watch in Telegram.

One container contains the Go binary, MediaMTX, FFmpeg and existing native libav RTMP sender (key via stdin). No Python runtime or Cloudflare dependency. A local demo uses generated media and simulated destination without connecting Telegram.

Verify controller, persistence, retries, ownership, authenticated controls and freshness with unit tests; upstream capture tests; Go race detector and vet; binary build; demo browser smoke. Actual Telegram publishing and resource measurements require VM cutover and a live source.
