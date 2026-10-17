package restream

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMediaRejectsMissingSourceAndProtectsSecrets(t *testing.T) {
	m := NewProcessMedia(context.Background(), t.TempDir(), "missing-sender")
	if err := m.Start(context.Background(), Source{}, "rtmps://secret/key"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
	if m.Healthy(time.Now()) {
		t.Fatal("unstarted media healthy")
	}
	m.Stop()
}
func TestOutputReadyNeedsSegmentsAndRecentPlaylist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.m3u8")
	_ = os.WriteFile(path, []byte("#EXTM3U\n"), 0600)
	if outputReady(path, time.Now()) {
		t.Fatal("empty media ready")
	}
	_ = os.WriteFile(path, []byte("#EXTM3U\n#EXTINF:2,\nsegment.ts\n"), 0600)
	if outputReady(path, time.Now()) {
		t.Fatal("missing segment ready")
	}
	_ = os.WriteFile(filepath.Join(dir, "segment.ts"), []byte("media"), 0600)
	if !outputReady(path, time.Now()) {
		t.Fatal("recent media not ready")
	}
	if outputReady(path, time.Now().Add(time.Minute)) {
		t.Fatal("stale output ready")
	}
}

func TestMediaFailureReportsOnlyKnownSenderReasons(t *testing.T) {
	for _, tc := range []struct{ message, want string }{
		{"RTMP sender: timestamp discontinuity or publishing lag", "timestamp discontinuity or publishing lag"},
		{"provider rtmps://private.example/super-secret-key", ""},
		{"RTMP sender: cannot connect publishing output https://private.example/key", ""},
	} {
		p, err := launch(exec.Command("sh", "-c", "printf '%s\\n' \"$1\" >&2; exit 1", "sender-test", tc.message))
		if err != nil {
			t.Fatal(err)
		}
		<-p.done
		reporter, ok := any(p).(interface{ Failure() string })
		if !ok {
			t.Fatal("media child discards the sender's safe failure reason")
		}
		if got := reporter.Failure(); got != tc.want {
			t.Fatalf("got %q want %q", got, tc.want)
		}
	}
}

func TestMediaAllowsSlowButBoundedHLSStartup(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	fixture := filepath.Join(dir, "fixture.ts")
	out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-an", "-f", "mpegts", fixture).CombinedOutput()
	if err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		// Keep transport reads progressing while media discovery takes 19s,
		// as with a cold HLS master plus nested playlist/segment requests.
		for i, delay := range []time.Duration{10 * time.Second, 9 * time.Second} {
			_, _ = w.Write(data[i*188 : (i+1)*188])
			w.(http.Flusher).Flush()
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		_, _ = w.Write(data[376:])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	m := NewProcessMedia(ctx, filepath.Join(dir, "output"), "")
	defer m.Stop()
	if err := m.StartPreview(ctx, Source{URL: srv.URL + "/live.ts"}); err != nil {
		t.Fatalf("playable input arriving after a 19-second cold start was rejected: %v", err)
	}
}

func TestLiveInputBurstCannotRunAheadOfPlayout(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	fixture := filepath.Join(dir, "burst.ts")
	out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-an", "-f", "mpegts", fixture).CombinedOutput()
	if err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		_, _ = w.Write(data)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	m := NewProcessMedia(ctx, filepath.Join(dir, "output"), "")
	defer m.Stop()
	began := time.Now()
	if err := m.StartPreview(ctx, Source{URL: srv.URL + "/live.ts"}); err != nil {
		t.Fatal(err)
	}
	p, err := os.ReadFile(filepath.Join(m.Dir, "index.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	var produced float64
	for _, line := range strings.Split(string(p), "\n") {
		if strings.HasPrefix(line, "#EXTINF:") {
			v, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ","), 64)
			if err != nil {
				t.Fatal(err)
			}
			produced += v
		}
	}
	if produced > time.Since(began).Seconds()+3 {
		t.Fatalf("input burst produced %.1fs of media in %.1fs, deleting unread sender segments", produced, time.Since(began).Seconds())
	}
}
