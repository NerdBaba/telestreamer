package restream

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type demoBackend struct {
	mu   sync.RWMutex
	rows []Source
}

func (d *demoBackend) Sources(context.Context) ([]Source, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return append([]Source{}, d.rows...), nil
}
func (d *demoBackend) Prepare(context.Context, Source) (bool, error) { return true, nil }
func (d *demoBackend) Open(context.Context) (string, error)          { return "demo://destination", nil }
func (d *demoBackend) Close(context.Context) error                   { return nil }
func (d *demoBackend) setLive(ids []string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, id := range ids {
		if id != "turbo" && id != "free" && id != "rwitc" {
			return fmt.Errorf("unknown demo source")
		}
	}
	for i := range d.rows {
		d.rows[i].Live = false
		for _, id := range ids {
			if d.rows[i].ID == id {
				d.rows[i].Live = true
			}
		}
		if d.rows[i].Live {
			d.rows[i].Detail = "Generated demo feed"
		} else {
			d.rows[i].Detail = "Waiting for a broadcast"
		}
	}
	return nil
}
func RunDemo(parent context.Context) error {
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dir := os.Getenv("DATA_DIR")
	if dir == "" {
		dir = ".demo-data"
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	addr := os.Getenv("DEMO_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8180"
	}
	backend := &demoBackend{rows: []Source{
		{ID: "turbo", ChatID: TurboChatID, Title: "TurboSportsLive", URL: "http://" + addr + "/demo-media/index.m3u8"},
		{ID: "free", ChatID: 2291644480, Title: "FREE LIVE INDIA RACING", URL: "http://" + addr + "/demo-media/index.m3u8"},
		{ID: "rwitc", Title: "RWITC Official", URL: "http://" + addr + "/demo-media/index.m3u8"},
	}}
	_ = backend.setLive([]string{"turbo", "free"})
	media := NewProcessMedia(ctx, filepath.Join(dir, "output"), "")
	media.Demo = true
	controller, err := NewController(filepath.Join(dir, "controls.json"), backend, backend, media)
	if err != nil {
		return err
	}
	controller.status.Demo = true
	dashboard, err := NewDashboard(controller, os.Getenv("ADMIN_TOKEN"), media.Dir)
	if err != nil {
		return err
	}
	dashboard.DemoControl = backend.setLive
	runDone := make(chan struct{})
	go func() { defer close(runDone); controller.Run(ctx) }()
	server := &http.Server{Addr: addr, Handler: dashboard, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	fmt.Printf("Demo stream desk: http://%s (no Telegram session opened)\n", addr)
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-done:
		cancel()
	}
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	_ = server.Shutdown(shutdown)
	<-runDone
	if serveErr != nil && serveErr != http.ErrServerClosed {
		return serveErr
	}
	return nil
}
