# Source provenance

This directory is a modified fork of TGTV by aleskxyz, commit
`69ddb30949cdeb604820a5d324e01b1b76a7b79a`, extracted from the existing
`tgtv_hf/tgtv-source.tar.gz` in this repository. The original AGPL-3.0-or-later
license is in `LICENSE`. Its module path remains unchanged to keep internal
imports traceable. The original capture engine and its regression tests are
retained. The fork adds `internal/restream`, lifecycle integration in
`internal/service/service.go`, CLI demo/import commands, and a portable memfd
fallback for macOS. It does not change the hosted HF deployment.

MediaMTX 1.19.2 is MIT licensed (see repository `tgtv_hf/LICENSE-mediamtx`).
The native sender is copied from this repository's `relay_engine/rtmp_sender.c`.
HLS.js 1.6.19 light build (Apache-2.0) is vendored in
`internal/restream/web/hls.min.js` with its license alongside it, downloaded
from the published npm distribution. Dashboard playback needs no external CDN.
The container serves its exact source archive to authenticated admins at
`/source.tar.gz`.
