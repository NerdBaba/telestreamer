package restream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMysoreRequiresFreshMediaAndReadableSegment(t *testing.T) {
	stale, broken := false, false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "Mozilla/5.0 (compatible; StreamDesk/1.0)" {
			t.Error("missing application user agent")
		}
		switch r.URL.Path {
		case "/api/mysore/live":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/api/mysore/live/token/media.m3u8\n")
		case "/api/mysore/live/token/media.m3u8":
			now := time.Now().UTC().Add(-2 * time.Second)
			if stale {
				now = now.Add(-time.Hour)
			}
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:2,\nsegment.ts\n", now.Format(time.RFC3339))
		case "/api/mysore/live/token/segment.ts":
			if broken {
				http.Error(w, "offline", 503)
			} else {
				fmt.Fprint(w, "segment")
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	m := Mysore{Client: server.Client(), Origin: server.URL}
	s, err := m.Resolve(context.Background())
	if err != nil || !s.Live || s.ID != "mysore" || s.URL != server.URL+"/api/mysore/live/token/media.m3u8" {
		t.Fatal(s, err)
	}
	stale = true
	s, err = m.Resolve(context.Background())
	if err != nil || s.Live {
		t.Fatal("stale playlist eligible", s, err)
	}
	stale, broken = false, true
	if _, err = m.Resolve(context.Background()); err == nil {
		t.Fatal("unreadable segment accepted")
	}
}
