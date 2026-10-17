package viewer

import (
	"context"
	"testing"
	"time"
)

func TestOutstandingMediaRequestDoesNotExpireAsIdle(t *testing.T) {
	idle := make(chan string, 1)
	m := NewManager(1, func(id string) { idle <- id })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.Start(ctx)
	defer m.Stop()
	watcher, ok := any(m).(interface{ Watch(string) func() })
	if !ok {
		t.Fatal("capture cannot keep an outstanding media request active during bootstrap")
	}
	release := watcher.Watch("live")
	select {
	case <-idle:
		release()
		t.Fatal("outstanding request expired during bootstrap")
	case <-time.After(2200 * time.Millisecond):
	}
	release()
	select {
	case id := <-idle:
		if id != "live" {
			t.Fatal(id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("released request did not become idle")
	}
}
