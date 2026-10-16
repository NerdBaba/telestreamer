package restream

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func isTestSource(id string) bool { return id == "test-rtmp" || id == "test-hls" }

// These public playback URLs were discovered on the web and decoded with
// FFmpeg on 2026-10-16. They are deliberately excluded from automatic fallback.
func PublicTestSources() []Source {
	rows := []Source{
		{ID: "test-rtmp", Title: "Novyny.Live · RTMP test", URL: "rtmp://95.67.11.153/klive/stream"},
		{ID: "test-hls", Title: "Al Jazeera English · HLS test", URL: "https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8"},
	}
	for i := range rows {
		rows[i].TestURL = rows[i].URL
		rows[i].Live = true
		rows[i].Detail = "Public live feed · manual testing only"
		rows[i].Headers = "User-Agent: Mozilla/5.0 (compatible; StreamDesk/1.0)\r\n"
		if rows[i].ID == "test-rtmp" {
			rows[i].Headers = ""
		}
	}
	return rows
}

// RTMPTestPreview copies the public RTMP input to private HLS only while an
// admin watches it. The outgoing relay continues reading the actual RTMP URL.
type RTMPTestPreview struct {
	mu       sync.Mutex
	media    *ProcessMedia
	url      string
	lastUsed time.Time
}

func NewRTMPTestPreview(ctx context.Context, dir, url string) *RTMPTestPreview {
	return &RTMPTestPreview{media: NewProcessMedia(ctx, dir, ""), url: url}
}

func (p *RTMPTestPreview) Prepare(ctx context.Context, source Source) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastUsed = time.Now()
	if p.media.ffmpeg == nil || p.media.ffmpeg.exited.Load() || !outputReady(filepath.Join(p.media.Dir, "index.m3u8"), time.Now()) {
		if err := p.media.StartPreview(ctx, source); err != nil {
			return "", err
		}
	}
	return p.url, nil
}

func (p *RTMPTestPreview) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if r.Method != "GET" || !mediaName.MatchString(name) || filepath.Base(name) != name {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(p.media.Dir, name))
}

func (p *RTMPTestPreview) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	defer func() { p.mu.Lock(); defer p.mu.Unlock(); p.media.Stop() }()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			p.mu.Lock()
			if now.Sub(p.lastUsed) > 30*time.Second {
				p.media.Stop()
			}
			p.mu.Unlock()
		}
	}
}
