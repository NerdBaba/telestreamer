package restream

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPRequiresAuthAndRejectsCrossSiteControls(t *testing.T) {
	c, _ := setup(t)
	h, err := NewDashboard(c, "01234567890123456789012345678901", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, method, origin, body string
		auth                       bool
		want                       int
	}{
		{"/api/status", "GET", "", "", false, 401},
		{"/api/status", "GET", "", "", true, 200},
		{"/", "GET", "", "", true, 200},
		{"/api/control", "POST", "https://evil.example", `{"auto":true}`, true, 403},
		{"/api/control", "POST", "", `{"auto":true,"paused":true}`, true, 200},
		{"/api/control", "POST", "", `{"unknown":true}`, true, 400},
		{"/api/control", "POST", "", `{"auto":true} garbage`, true, 400},
		{"/output/../controls.json", "GET", "", "", true, 404},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		if tc.auth {
			req.SetBasicAuth("admin", h.token)
		}
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s %s got %d want %d: %s", tc.method, tc.path, rec.Code, tc.want, rec.Body.String())
		}
	}
}
func TestDashboardRejectsWeakSecret(t *testing.T) {
	c, _ := setup(t)
	if _, err := NewDashboard(c, "short", t.TempDir()); err == nil {
		t.Fatal("weak secret accepted")
	}
}
func TestPreviewRewritesBothURILinesAndTags(t *testing.T) {
	p := previewProxy{links: make(map[string]previewLink)}
	text := p.rewrite("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nseg.ts\n", "turbo", "https://example.com/index.m3u8", "")
	if strings.Contains(text, "init.mp4") || strings.Contains(text, "seg.ts") || strings.Count(text, "/preview/turbo/") != 2 {
		t.Fatal(text)
	}
	for _, link := range p.links {
		if !strings.HasPrefix(link.url, "https://example.com/") {
			t.Fatal(link)
		}
	}
}

var _ http.Handler = (*Dashboard)(nil)

func TestOpaqueWebViewOriginRequiresBrowserSameOriginMetadata(t *testing.T) {
	for _, tc := range []struct {
		origin, site string
		want         bool
	}{
		{"null", "same-origin", true}, {"null", "", false}, {"null", "cross-site", false}, {"https://evil.example", "same-origin", false}, {"http://example.com", "same-origin", true},
	} {
		r := httptest.NewRequest("POST", "http://example.com/api/control", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		if sameOrigin(r) != tc.want {
			t.Fatal(tc)
		}
	}
}

func TestStatusNeverExposesProviderCredentials(t *testing.T) {
	c, f := setup(t)
	s := source("turbo", TurboChatID)
	s.URL = "https://private.example/secret-path"
	s.Headers = "Cookie: signed-secret"
	f.sources = []Source{s}
	tick(c, 100)
	h, _ := NewDashboard(c, "01234567890123456789012345678901", t.TempDir())
	r := httptest.NewRequest("GET", "/api/status", nil)
	r.SetBasicAuth("admin", h.token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	for _, secret := range []string{"secret-path", "signed-secret", h.token} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("credential leaked in status")
		}
	}
	r = httptest.NewRequest("GET", "/p/private/playlist.m3u", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.SetBasicAuth("admin", h.token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("private capture mounted on admin listener")
	}
}
