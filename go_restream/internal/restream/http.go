package restream

import (
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var web embed.FS
var mediaName = regexp.MustCompile(`^[A-Za-z0-9_-]+\.(m3u8|ts|mp4|m4s)$`)
var tagURI = regexp.MustCompile(`URI="([^"]+)"`)

type previewLink struct {
	url, headers, source string
	at                   time.Time
}
type previewProxy struct {
	mu     sync.Mutex
	links  map[string]previewLink
	client *http.Client
}

func (p *previewProxy) link(source, raw, headers string) string {
	sum := sha256.Sum256([]byte(source + raw + headers))
	key := hex.EncodeToString(sum[:16])
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.links) > 2048 {
		for k, v := range p.links {
			if time.Since(v.at) > 2*time.Minute {
				delete(p.links, k)
			}
		}
	}
	if len(p.links) > 4096 {
		return "/preview/expired"
	}
	p.links[key] = previewLink{url: raw, headers: headers, source: source, at: time.Now()}
	return "/preview/" + url.PathEscape(source) + "/" + key
}
func (p *previewProxy) rewrite(text, source, base, headers string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			lines[i] = p.link(source, resolveURL(base, line), headers)
		} else {
			lines[i] = tagURI.ReplaceAllStringFunc(line, func(v string) string {
				ref := tagURI.FindStringSubmatch(v)[1]
				return `URI="` + p.link(source, resolveURL(base, ref), headers) + `"`
			})
		}
	}
	return strings.Join(lines, "\n")
}

type Dashboard struct {
	controller            *Controller
	token, cookie, output string
	proxy                 previewProxy
	static                http.Handler
	SourceArchive         string
	DemoControl           func([]string) error
}

func NewDashboard(c *Controller, token, output string) (*Dashboard, error) {
	if len(token) < 32 {
		return nil, fmt.Errorf("ADMIN_TOKEN must contain at least 32 characters")
	}
	assets, _ := fs.Sub(web, "web")
	sum := sha256.Sum256([]byte("admin-cookie:" + token))
	return &Dashboard{controller: c, token: token, cookie: hex.EncodeToString(sum[:]), output: output, proxy: previewProxy{links: make(map[string]previewLink), client: &http.Client{Timeout: 25 * time.Second}}, static: http.FileServer(http.FS(assets))}, nil
}
func equal(a, b string) bool {
	x := sha256.Sum256([]byte(a))
	y := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}
func (d *Dashboard) authorized(r *http.Request) bool {
	if user, password, ok := r.BasicAuth(); ok && user == "admin" && equal(password, d.token) {
		return true
	}
	if raw := r.Header.Get("Authorization"); strings.HasPrefix(raw, "Bearer ") && equal(strings.TrimPrefix(raw, "Bearer "), d.token) {
		return true
	}
	c, err := r.Cookie("restream_admin")
	return err == nil && equal(c.Value, d.cookie)
}
func sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	if raw := r.Header.Get("Origin"); raw != "" {
		if raw == "null" {
			return r.Header.Get("Sec-Fetch-Site") == "same-origin"
		}
		u, err := url.Parse(raw)
		return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https")
	}
	return true
}
func (d *Dashboard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'")
	if r.URL.Path == "/health" {
		jsonResponse(w, map[string]string{"status": "ok"})
		return
	}
	// The inherited path-token API is for local media processes only.
	if r.URL.Path == "/demo-media/index.m3u8" || strings.HasPrefix(r.URL.Path, "/demo-media/") {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(host); d.DemoControl != nil && ip != nil && ip.IsLoopback() {
			name := strings.TrimPrefix(r.URL.Path, "/demo-media/")
			if mediaName.MatchString(name) {
				http.ServeFile(w, r, filepath.Join(d.output, name))
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/p/") {
		http.NotFound(w, r)
		return
	}

	if r.URL.Path == "/login" {
		if r.Method == "POST" {
			if !sameOrigin(r) {
				http.Error(w, "Cross-site request refused", 403)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 4096)
			if r.ParseForm() != nil || !equal(r.FormValue("token"), d.token) {
				http.Error(w, "Invalid admin token", 401)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "restream_admin", Value: d.cookie, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", MaxAge: 86400})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		if r.Method != "GET" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		d.static.ServeHTTP(w, withPath(r, "/login.html"))
		return
	}
	// Login page's stylesheet contains no private content.
	if r.URL.Path == "/app.css" {
		d.static.ServeHTTP(w, r)
		return
	}
	if !d.authorized(r) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
		} else {
			http.Error(w, "Authentication required", 401)
		}
		return
	}
	switch {
	case r.URL.Path == "/api/demo" && r.Method == "POST" && d.DemoControl != nil:
		if !sameOrigin(r) {
			http.Error(w, "Cross-site request refused", 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		var body struct {
			Live []string `json:"live"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || d.DemoControl(body.Live) != nil {
			http.Error(w, "Invalid demo sources", 400)
			return
		}
		jsonResponse(w, map[string]bool{"ok": true})
	case r.URL.Path == "/api/status" && r.Method == "GET":
		jsonResponse(w, d.controller.Snapshot())
	case r.URL.Path == "/api/control" && r.Method == "POST":
		if !sameOrigin(r) {
			http.Error(w, "Cross-site request refused", 403)
			return
		}
		if kind, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); kind != "application/json" {
			http.Error(w, "JSON required", 415)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var controls Controls
		if err := decoder.Decode(&controls); err != nil {
			http.Error(w, "Invalid control request", 400)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			http.Error(w, "One JSON object required", 400)
			return
		}
		if err := d.controller.Control(controls); err != nil {
			http.Error(w, "Controls could not be saved", 400)
			return
		}
		jsonResponse(w, d.controller.Snapshot())
	case strings.HasPrefix(r.URL.Path, "/preview/") && r.Method == "GET":
		d.preview(w, r)
	case strings.HasPrefix(r.URL.Path, "/output/") && r.Method == "GET":
		name := strings.TrimPrefix(r.URL.Path, "/output/")
		if !mediaName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		if d.controller.Snapshot().Active == "" {
			http.Error(w, "Output is idle", 503)
			return
		}
		http.ServeFile(w, r, filepath.Join(d.output, name))
	case r.URL.Path == "/source.tar.gz" && r.Method == "GET":
		if d.SourceArchive != "" {
			http.ServeFile(w, r, d.SourceArchive)
		} else {
			http.NotFound(w, r)
		}
	case r.URL.Path == "/" && r.Method == "GET":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		data, _ := web.ReadFile("web/index.html")
		_, _ = w.Write(data)
	case r.Method == "GET" && (r.URL.Path == "/app.js" || r.URL.Path == "/hls.min.js" || r.URL.Path == "/HLS-LICENSE.txt"):
		d.static.ServeHTTP(w, r)
	default:
		http.NotFound(w, r)
	}
}
func withPath(r *http.Request, path string) *http.Request {
	copy := r.Clone(r.Context())
	u := *r.URL
	u.Path = path
	copy.URL = &u
	return copy
}
func jsonResponse(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func (d *Dashboard) preview(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/preview/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	var source Source
	for _, s := range d.controller.Snapshot().Sources {
		if s.ID == parts[0] && s.Live {
			source = s
			break
		}
	}
	if source.ID == "" {
		http.Error(w, "Source is offline", 503)
		return
	}
	raw, headers := source.URL, source.Headers
	if parts[1] != "index.m3u8" {
		d.proxy.mu.Lock()
		link, ok := d.proxy.links[parts[1]]
		d.proxy.mu.Unlock()
		if !ok || link.source != source.ID {
			http.NotFound(w, r)
			return
		}
		raw, headers = link.url, link.headers
	}
	req, err := http.NewRequestWithContext(r.Context(), "GET", raw, nil)
	if err != nil {
		http.Error(w, "Preview unavailable", 502)
		return
	}
	for _, line := range strings.Split(headers, "\r\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok {
			req.Header.Set(k, strings.TrimSpace(v))
		}
	}
	if v := r.Header.Get("Range"); v != "" {
		req.Header.Set("Range", v)
	}
	resp, err := d.proxy.client.Do(req)
	if err != nil {
		http.Error(w, "Preview is starting or unavailable", 502)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		http.Error(w, "Preview is starting or unavailable", 503)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil || len(data) > 16<<20 {
		http.Error(w, "Preview unavailable", 502)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if strings.HasPrefix(strings.TrimSpace(string(data[:min(len(data), 64)])), "#EXTM3U") {
		ct = "application/vnd.apple.mpegurl"
		data = []byte(d.proxy.rewrite(string(data), source.ID, raw, headers))
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	for _, key := range []string{"Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}
