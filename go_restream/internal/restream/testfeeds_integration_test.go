package restream

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Explicit network opt-in; never loads a Telegram session or publishes output.
func TestPublicRTMPPreviewIntegration(t *testing.T) {
	if os.Getenv("STREAMDESK_PUBLIC_FEED_TEST") != "1" {
		t.Skip("set STREAMDESK_PUBLIC_FEED_TEST=1 for public RTMP decode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	preview := NewRTMPTestPreview(ctx, t.TempDir(), "")
	defer preview.media.Stop()
	files := httptest.NewServer(preview)
	defer files.Close()
	preview.url = files.URL + "/index.m3u8"
	c, f := setup(t)
	f.sources = PublicTestSources()
	_ = c.Control(Controls{Auto: true, Paused: true})
	tick(c, 100)
	h, _ := NewDashboard(c, strings.Repeat("x", 32), t.TempDir())
	h.PreparePreview = preview.Prepare
	server := httptest.NewServer(h)
	defer server.Close()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-rw_timeout", "10000000", "-headers", "Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("admin:"+h.token))+"\r\n", "-i", server.URL+"/preview/test-rtmp/index.m3u8", "-t", "3", "-f", "null", "-")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("RTMP → private HLS → decoded video: %v: %s", err, output)
	}
}
