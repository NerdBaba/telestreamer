---
title: Turbo Live Relay Trial
sdk: gradio
sdk_version: 6.30.0
python_version: '3.12'
app_file: app.py
license: agpl-3.0
pinned: false
---

Gradio deployment of unmodified tgtv and MediaMTX. Live streaming always runs on CPU. An optional CUDA video-thumbnail function uses ZeroGPU only when requested; quota or allocation failures fall back to CPU thumbnail processing without changing the stream. No artificial keep-alive traffic.

Configure TELEGRAM_API_ID, TELEGRAM_API_HASH, SESSION_JSON_B64, PATH_SECRET, and MEDIAMTX_HLS_CDN_SECRET as Space secrets. Stop every other client using the same Telegram session before configuring SESSION_JSON_B64. Runtime files are private and ephemeral; the saved session is restored from the secret on restart. Do not commit credentials.

The public entry point is Gradio on port 7860. tgtv, MediaMTX HLS, and internal RTMP listen only on loopback. The playback-token-protected HLS proxy and browser player share the public HTTPS origin. External publishing must use a supported outbound port; port 1935 is not allowed by Spaces.

Free Spaces can sleep or restart; this is a temporary trial, not an uptime guarantee. The created Space is hosted in the US, not India.

## Preview and streaming isolation

`preview.py` captures one video frame with FFmpeg on CPU, then uses real CUDA tensor interpolation to generate the displayed thumbnail. GPU allocation is limited to the optional thumbnail operation. Allocation failures, including exhausted quota, are caught outside the GPU decorator and use CPU interpolation instead. No streaming, Telegram login, HLS proxy, or process lifecycle operation depends on the GPU function.

The Gradio launcher performs the supported ZeroGPU startup handshake. CPU media endpoints remain outside Gradio's GPU request queue. The initial CPU-only trial failed ZeroGPU's GPU-function check; this revision adds a genuine preview operation, not a dummy decorator.

The quota-denial regression runs with `python -m unittest tgtv_hf.test_preview -v` from the local project root. A real FFmpeg frame-capture smoke also exercised CPU fallback on a machine without CUDA. Hosted results are recorded in the project's `TELEGRAM_SETUP.md`.

## Source and licenses

- tgtv: Copyright (C) 2026 aleskxyz; AGPL-3.0-or-later. The bundled executable is unmodified commit `69ddb30949cdeb604820a5d324e01b1b76a7b79a`. Corresponding source is included as `tgtv-source.tar.gz`; license is `LICENSE-tgtv`. [Upstream source](https://github.com/aleskxyz/tgtv/tree/69ddb30949cdeb604820a5d324e01b1b76a7b79a).
- MediaMTX: v1.19.2, MIT license, Copyright (c) 2019 aler9. License is `LICENSE-mediamtx`. [Source](https://github.com/bluenviron/mediamtx/tree/v1.19.2).
- The Gradio adapter source is available in this repository under AGPL-3.0-or-later.
