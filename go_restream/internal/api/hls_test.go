package api

import (
	"strings"
	"testing"

	"github.com/aleskxyz/tgtv/internal/config"
)

func TestValidHLSFilename(t *testing.T) {
	cases := map[string]bool{
		"index.m3u8":       true,
		"seg0.ts":          true,
		"main_stream.m3u8": true,
		"../etc/passwd":    false,
		"seg/0.ts":         false,
		"":                 false,
	}
	for name, want := range cases {
		if got := validHLSFilename(name); got != want {
			t.Fatalf("validHLSFilename(%q)=%v want %v", name, got, want)
		}
	}
}

func TestInjectDiscontinuityMediaPlaylist(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nseg0.ts\n"
	out := InjectDiscontinuity(in)
	if !containsLine(out, "#EXT-X-DISCONTINUITY") {
		t.Fatalf("expected discontinuity tag in media playlist:\n%s", out)
	}
}

func TestInjectDiscontinuitySkipsMasterPlaylist(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://example/hls/main_stream.m3u8\n"
	out := InjectDiscontinuity(in)
	if out != in {
		t.Fatalf("master playlist must be unchanged:\n%s", out)
	}
}

func containsLine(text, line string) bool {
	for _, l := range splitLines(text) {
		if l == line {
			return true
		}
	}
	return false
}

func splitLines(text string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			line := text[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}

func TestRewriteHLSPreservesReaderSession(t *testing.T) {
	base := "http://127.0.0.1:8091/p/secret/hls/stream"
	in := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio.m3u8?session=reader-123\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain_stream.m3u8?session=reader-123\n"
	out := RewriteHLSPlaylist(in, base)
	for _, want := range []string{base + "/audio.m3u8?session=reader-123", base + "/main_stream.m3u8?session=reader-123"} {
		if !strings.Contains(out, want) {
			t.Fatalf("reader session lost: want %q in %q", want, out)
		}
	}
}

func TestMediamtxURLForwardsReaderQuery(t *testing.T) {
	s := &Server{cfg: config.Settings{MediamtxHLSURL: "http://127.0.0.1:8888"}}
	want := "http://127.0.0.1:8888/live/stream/main_stream.m3u8?session=reader-123&_HLS_msn=42"
	if got := s.mediamtxURL("stream", "main_stream.m3u8", "session=reader-123&_HLS_msn=42"); got != want {
		t.Fatalf("reader query lost: got %q want %q", got, want)
	}
}
