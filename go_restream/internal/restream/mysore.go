package restream

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"
)

// Mysore reuses the existing Worker's venue resolver, while independently
// checking media timestamps and a segment before allowing automatic playout.
type Mysore struct {
	Client *http.Client
	Origin string
}

func (m Mysore) Resolve(ctx context.Context) (Source, error) {
	origin := m.Origin
	if origin == "" {
		origin = os.Getenv("MYSORE_WORKER_ORIGIN")
	}
	if origin == "" {
		origin = "https://rwitc-racing.curos282.workers.dev"
	}
	client := m.Client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	return verifyHLS(ctx, client, Source{ID: "mysore", Title: "Mysore Race Club", Detail: "No live media", Headers: "User-Agent: Mozilla/5.0 (compatible; StreamDesk/1.0)\r\n"}, strings.TrimRight(origin, "/")+"/api/mysore/live")
}
