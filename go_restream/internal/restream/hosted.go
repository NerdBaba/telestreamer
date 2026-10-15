package restream

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gotd/td/session"
)

func stateRequest(ctx context.Context, method, key string, data []byte) ([]byte, error) {
	endpoint := strings.TrimRight(os.Getenv("STATE_URL"), "/") + "/" + key
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("invalid state endpoint")
	}
	request.Header.Set("Authorization", "Bearer "+os.Getenv("STATE_TOKEN"))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "Mozilla/5.0 (compatible; StreamDesk/1.0)")
	client := http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("durable state unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return nil, os.ErrNotExist
	}
	if response.StatusCode == 409 {
		return nil, fmt.Errorf("another instance owns the Telegram session")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("durable state request failed (%d)", response.StatusCode)
	}
	value, err := io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(value) > 32768 {
		return nil, fmt.Errorf("invalid durable state response")
	}
	return value, nil
}
func remoteKey(path string) string {
	switch filepath.Base(path) {
	case "controls.json":
		return "controls"
	case "owned-call.json":
		return "owned-call"
	}
	return ""
}
func readState(path string) ([]byte, error) {
	if os.Getenv("STATE_URL") == "" || remoteKey(path) == "" {
		return os.ReadFile(path)
	}
	return stateRequest(context.Background(), "GET", remoteKey(path), nil)
}
func RestoreHostedSession(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	raw := os.Getenv("SESSION_JSON_B64")
	if raw == "" {
		return nil
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return fmt.Errorf("SESSION_JSON_B64 is invalid")
	}
	storage := &session.StorageMemory{}
	if err = storage.StoreSession(context.Background(), data); err != nil {
		return fmt.Errorf("session storage unavailable")
	}
	parsed, err := (&session.Loader{Storage: storage}).Load(context.Background())
	if err != nil || len(parsed.AuthKey) != 256 || len(parsed.AuthKeyID) != 8 || parsed.DC < 1 || parsed.DC > 5 {
		return fmt.Errorf("SESSION_JSON_B64 is not an authorized gotd session")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("cannot restore session")
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("cannot persist restored session")
	}
	return nil
}

// AcquireHostedLease prevents overlapping hosted instances from connecting the
// same auth key. A new release waits for the previous holder to stop; it never
// forcibly steals an active lease. Cut over Render by suspending then resuming.
func AcquireHostedLease(ctx context.Context, onLost func()) (func(), error) {
	if os.Getenv("STATE_URL") == "" {
		return func() {}, nil
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	owner := hex.EncodeToString(id[:])
	request := func(ctx context.Context, action string) error {
		data, _ := json.Marshal(map[string]string{"owner": owner, "action": action})
		_, err := stateRequest(ctx, "POST", "lease", data)
		return err
	}
	deadline := time.NewTimer(120 * time.Second)
	defer deadline.Stop()
	for {
		if err := request(ctx, "acquire"); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("session lease unavailable; stop the former holder before deploying")
		case <-time.After(5 * time.Second):
		}
	}
	hold, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-hold.Done():
				return
			case <-tick.C:
				if request(hold, "acquire") != nil {
					onLost()
					return
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
		release, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = request(release, "release")
	}, nil
}
