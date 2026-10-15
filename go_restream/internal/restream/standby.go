package restream

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Standby lets a hosted cutover replace the former image before this image
// opens the shared Telegram authorization. It never reads or restores a session.
func RunStandby(ctx context.Context) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	host, port := os.Getenv("HTTP_HOST"), os.Getenv("HTTP_PORT")
	if host == "" {
		host = "0.0.0.0"
	}
	if port == "" {
		port = "8090"
	}
	server := &http.Server{Addr: net.JoinHostPort(host, port), Handler: http.HandlerFunc(standbyHTTP), ReadHeaderTimeout: 5 * time.Second}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = server.Shutdown(shutdown)
		case <-done:
		}
	}()
	err := server.ListenAndServe()
	close(done)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func standbyHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/health" || r.URL.Path == "/healthz" {
		jsonResponse(w, map[string]any{"status": "standby", "telegram_connected": false})
		return
	}
	http.Error(w, "Telegram cutover standby", http.StatusServiceUnavailable)
}
