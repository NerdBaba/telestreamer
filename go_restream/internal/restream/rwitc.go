package restream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type RWITC struct {
	Client *http.Client
	API    string
}

var lambdaRef = regexp.MustCompile(`fetch\(\s*['"](https?://[^'"]*lambda-url[^'"]*)['"]`)
var masterRef = regexp.MustCompile(`['"]([^'"]*index\.m3u8(?:\?[^'"]*)?)['"]`)

func resolveURL(base, ref string) string {
	b, e := url.Parse(base)
	if e != nil {
		return ""
	}
	r, e := url.Parse(ref)
	if e != nil {
		return ""
	}
	return b.ResolveReference(r).String()
}
func get(ctx context.Context, client *http.Client, url, headers string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; StreamDesk/1.0)")
	for _, line := range strings.Split(headers, "\r\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			req.Header.Set(key, strings.TrimSpace(value))
		}
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("upstream status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if len(data) > 2<<20 {
		return nil, fmt.Errorf("upstream response too large")
	}
	return data, err
}
func playlistRefs(body, base string) []string {
	var out []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, resolveURL(base, line))
		}
	}
	return out
}
func freshMedia(body string, now time.Time) bool {
	if !strings.HasPrefix(strings.TrimSpace(body), "#EXTM3U") || strings.Contains(body, "#EXT-X-ENDLIST") {
		return false
	}
	var end time.Time
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:") {
			v, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:")))
			if err != nil {
				return false
			}
			end = v
		}
		if strings.HasPrefix(line, "#EXTINF:") && !end.IsZero() {
			v, _ := strconv.ParseFloat(strings.Split(strings.TrimPrefix(line, "#EXTINF:"), ",")[0], 64)
			if v < 0 || v > 60 {
				return false
			}
			end = end.Add(time.Duration(v * float64(time.Second)))
		}
	}
	return !end.IsZero() && now.Sub(end) < 5*time.Minute && end.Sub(now) < 30*time.Second
}
func (r RWITC) Resolve(ctx context.Context) (Source, error) {
	s := Source{ID: "rwitc", Title: "RWITC Official", Detail: "No live media"}
	api := r.API
	if api == "" {
		api = "https://api.rwitc.com"
	}
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	data, err := get(ctx, client, api+"/login/stream", "")
	if err != nil {
		return s, err
	}
	var records struct {
		Data []struct {
			Status string `json:"status"`
			Date   string `json:"race_date"`
			URL    string `json:"stream_url"`
		}
	}
	if err = json.Unmarshal(data, &records); err != nil {
		return s, err
	}
	player, bestDate := "", ""
	for _, record := range records.Data {
		if record.Status == "active" && strings.TrimSpace(record.URL) != "" && (player == "" || record.Date >= bestDate) {
			player = resolveURL(api+"/", record.URL)
			bestDate = record.Date
		}
	}
	if player == "" {
		return s, nil
	}
	data, err = get(ctx, client, player, "")
	if err != nil {
		return s, err
	}
	lambda, master := lambdaRef.FindSubmatch(data), masterRef.FindSubmatch(data)
	if len(lambda) < 2 || len(master) < 2 {
		return s, fmt.Errorf("player references missing")
	}
	masterURL := resolveURL(player, string(master[1]))
	data, err = get(ctx, client, string(lambda[1]), "Origin: "+api+"\r\n")
	if err != nil {
		return s, err
	}
	var signing struct {
		Status    string
		Key       string `json:"keyPairId"`
		Policy    string `json:"encodedPolicy"`
		Signature string `json:"encodedSignature"`
	}
	if err = json.Unmarshal(data, &signing); err != nil {
		return s, err
	}
	if signing.Status != "success" || signing.Key == "" || signing.Policy == "" || signing.Signature == "" {
		return s, fmt.Errorf("signing unavailable")
	}
	for _, v := range []string{signing.Key, signing.Policy, signing.Signature} {
		if strings.ContainsAny(v, "\r\n") {
			return s, fmt.Errorf("invalid signing")
		}
	}
	s.Headers = fmt.Sprintf("Cookie: CloudFront-Key-Pair-Id=%s; CloudFront-Policy=%s; CloudFront-Signature=%s\r\n", signing.Key, signing.Policy, signing.Signature)
	return verifyHLS(ctx, client, s, masterURL)
}

func verifyHLS(ctx context.Context, client *http.Client, s Source, masterURL string) (Source, error) {
	data, err := get(ctx, client, masterURL, s.Headers)
	if err != nil {
		return s, err
	}
	mediaURL := masterURL
	if !strings.Contains(string(data), "#EXTINF:") {
		refs := playlistRefs(string(data), masterURL)
		if len(refs) == 0 {
			return s, fmt.Errorf("no HLS variants")
		}
		mediaURL = refs[0]
		data, err = get(ctx, client, mediaURL, s.Headers)
		if err != nil {
			return s, err
		}
	}
	if !freshMedia(string(data), time.Now().UTC()) {
		s.Detail = "Offline or stale media"
		return s, nil
	}
	refs := playlistRefs(string(data), mediaURL)
	if len(refs) == 0 {
		return s, nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", refs[len(refs)-1], nil)
	if err != nil {
		return s, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; StreamDesk/1.0)")
	for _, line := range strings.Split(s.Headers, "\r\n") {
		if key, value, ok := strings.Cut(line, ":"); ok {
			req.Header.Set(key, strings.TrimSpace(value))
		}
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := client.Do(req)
	if err != nil {
		return s, err
	}
	defer resp.Body.Close()
	var b [1]byte
	n, _ := resp.Body.Read(b[:])
	if (resp.StatusCode != 200 && resp.StatusCode != 206) || n != 1 {
		return s, fmt.Errorf("media segment unavailable")
	}
	s.URL = mediaURL
	s.Live = true
	s.Detail = "Recent media verified"
	return s, nil
}
