package restream

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestPublicTestFeedsRequireManualSelection(t *testing.T) {
	rows := []Source{source("test-rtmp", 0), source("test-hls", 0)}
	if s := choose(rows, Controls{Auto: true, Fallbacks: []string{"test-rtmp", "test-hls"}}); s != nil {
		t.Fatal("test media chosen automatically", s)
	}
	if s := choose(rows, Controls{Auto: true, Forced: "test-rtmp"}); s == nil || s.ID != "test-rtmp" {
		t.Fatal("manual source unavailable", s)
	}
}
func TestRTMPPreviewUsesPreparedHLSWithoutChangingRelayInput(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Write([]byte("#EXTM3U\n#EXTINF:2,\nsegment.ts\n"))
	}))
	defer upstream.Close()
	c, f := setup(t)
	original := "rtmp://public.example/live/news"
	f.sources = []Source{{ID: "test-rtmp", Live: true, URL: original}}
	_ = c.Control(Controls{Auto: true, Paused: true})
	tick(c, 100)
	h, _ := NewDashboard(c, strings.Repeat("x", 32), t.TempDir())
	prepared := 0
	h.PreparePreview = func(ctx context.Context, s Source) (string, error) {
		prepared++
		if s.URL != original {
			t.Fatal(s)
		}
		return upstream.URL + "/index.m3u8", nil
	}
	r := httptest.NewRequest("GET", "/preview/test-rtmp/index.m3u8", nil)
	r.SetBasicAuth("admin", h.token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "/preview/test-rtmp/") || prepared != 1 || c.Snapshot().Sources[0].URL != original {
		t.Fatal(w.Code, w.Body.String(), prepared)
	}
}
func TestPublicTestSourcesBypassTelegramCapture(t *testing.T) {
	c := Capture{}
	for _, s := range PublicTestSources() {
		if ready, err := c.Prepare(context.Background(), s); err != nil || !ready {
			t.Fatal(s, ready, err)
		}
	}
}

func TestRTMPPreviewKeepsRunningWhileSegmentsAreRequested(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := NewRTMPTestPreview(ctx, t.TempDir(), "http://127.0.0.1/test-preview/index.m3u8")
	p.media.Demo = true
	defer p.media.Stop()
	if _, err := p.Prepare(ctx, Source{URL: "generated"}); err != nil {
		t.Fatal(err)
	}
	// HLS players fetch the master once, then keep fetching child media files.
	p.lastUsed = time.Now().Add(-time.Minute)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/index.m3u8", nil))
	if w.Code != 200 {
		t.Fatalf("preview playlist: HTTP %d", w.Code)
	}
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx) }()
	defer func() { cancel(); <-done }()
	select {
	case <-time.After(6 * time.Second):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	p.mu.Lock()
	healthy := p.media.Healthy(time.Now())
	p.mu.Unlock()
	if !healthy {
		t.Fatal("preview was stopped as idle while the viewer was still requesting HLS media")
	}
}
