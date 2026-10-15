package restream

import (
	"context"
	"os"
	"path/filepath"
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
