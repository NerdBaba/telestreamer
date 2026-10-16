//go:build stress

package restream

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Explicit opt-in harness. It uses the production media/controller/dashboard
// code with a generated HLS input and a loopback RTMP destination; no MTProto
// client or real session is loaded. See deploy/stress_backend.py.
func TestBackendStress(t *testing.T) {
	if os.Getenv("STRESS_SOURCE_URL") == "" {
		t.Skip("run through deploy/stress_backend.py")
	}
	t.Setenv("STATE_URL", "")
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dir := t.TempDir()
	source := &demoBackend{rows: []Source{{ID: "turbo", ChatID: TurboChatID, Title: "Generated stress input", Live: true, URL: os.Getenv("STRESS_SOURCE_URL")}}}
	destination := &stressDestination{url: os.Getenv("STRESS_RTMP_URL")}
	media := NewProcessMedia(ctx, filepath.Join(dir, "output"), os.Getenv("STRESS_SENDER"))
	controller, err := NewController(filepath.Join(dir, "controls.json"), source, destination, media)
	if err != nil {
		t.Fatal(err)
	}
	dashboard, err := NewDashboard(controller, os.Getenv("STRESS_TOKEN"), media.Dir)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: dashboard, ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener)
	done := make(chan struct{})
	go func() { defer close(done); controller.Run(ctx) }()
	if err := os.WriteFile(os.Getenv("STRESS_ADDRESS_FILE"), []byte("http://"+listener.Addr().String()), 0600); err != nil {
		t.Fatal(err)
	}
	<-ctx.Done()
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	_ = server.Shutdown(shutdown)
	<-done
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"opens": destination.opens, "closes": destination.closes})
}

type stressDestination struct {
	url           string
	opens, closes int
}

func (d *stressDestination) Open(context.Context) (string, error) { d.opens++; return d.url, nil }
func (d *stressDestination) Close(context.Context) error          { d.closes++; return nil }
