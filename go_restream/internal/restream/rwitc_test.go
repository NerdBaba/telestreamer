package restream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRWITCResolvesSigningAndRejectsEndedMedia(t *testing.T) {
	ended := false
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/stream":
			fmt.Fprint(w, `{"data":[{"status":"active","race_date":"2026-10-15","stream_url":"/player"}]}`)
		case "/player":
			fmt.Fprintf(w, `fetch('%s/signer.lambda-url.test'); var url='%s/index.m3u8';`, server.URL, server.URL)
		case "/signer.lambda-url.test":
			if r.Header.Get("Origin") != server.URL {
				t.Error("missing Origin")
			}
			fmt.Fprint(w, `{"status":"success","keyPairId":"key","encodedPolicy":"policy","encodedSignature":"signature"}`)
		case "/index.m3u8":
			if r.Header.Get("Cookie") == "" {
				t.Error("missing cookie")
			}
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n")
		case "/media.m3u8":
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:2,\nseg.ts\n", time.Now().UTC().Add(-2*time.Second).Format(time.RFC3339))
			if ended {
				fmt.Fprint(w, "#EXT-X-ENDLIST\n")
			}
		case "/seg.ts":
			fmt.Fprint(w, "segment")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	r := RWITC{Client: server.Client(), API: server.URL}
	s, err := r.Resolve(context.Background())
	if err != nil || !s.Live || s.Headers == "" {
		t.Fatal(s, err)
	}
	ended = true
	s, err = r.Resolve(context.Background())
	if err != nil || s.Live {
		t.Fatal("ended playlist marked live", s, err)
	}
}
func TestMediaFreshness(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		text string
		live bool
	}{
		{"#EXTM3U\n#EXTINF:2,\na.ts", false},
		{"#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:" + now.Add(-10*time.Minute).Format(time.RFC3339) + "\n#EXTINF:2,\na.ts", false},
		{"#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:" + now.Add(time.Hour).Format(time.RFC3339) + "\n#EXTINF:2,\na.ts", false},
		{"#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:" + now.Add(-time.Second).Format(time.RFC3339) + "\n#EXTINF:2,\na.ts", true},
	} {
		if got := freshMedia(tc.text, now); got != tc.live {
			t.Fatalf("got %v for %s", got, tc.text)
		}
	}
}
