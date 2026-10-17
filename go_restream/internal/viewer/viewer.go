package viewer

import (
	"context"
	"sync"
	"time"
)

type Manager struct {
	idleGrace time.Duration
	onIdle    func(streamID string)

	mu       sync.Mutex
	last     map[string]time.Time
	active   map[string]int
	stopping sync.Map
	cancel   context.CancelFunc
	done     chan struct{}
}

func NewManager(idleGraceSeconds int, onIdle func(string)) *Manager {
	return &Manager{
		idleGrace: time.Duration(idleGraceSeconds) * time.Second,
		onIdle:    onIdle,
		last:      make(map[string]time.Time),
		active:    make(map[string]int),
		done:      make(chan struct{}),
	}
}

func (m *Manager) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)
	go m.loop(ctx)
}

func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	<-m.done
}

func (m *Manager) RecordActivity(streamID string) {
	m.mu.Lock()
	m.last[streamID] = time.Now()
	m.mu.Unlock()
}

// Watch holds activity while an HTTP media request is waiting for bootstrap or
// readiness. A slow but connected viewer must not be stopped by the idle timer.
func (m *Manager) Watch(streamID string) func() {
	m.mu.Lock()
	m.active[streamID]++
	m.last[streamID] = time.Now()
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.active[streamID]--
			if m.active[streamID] == 0 {
				delete(m.active, streamID)
			}
			m.last[streamID] = time.Now()
		})
	}
}

func (m *Manager) loop(ctx context.Context) {
	defer close(m.done)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			var idle []string
			m.mu.Lock()
			for id, ts := range m.last {
				if m.active[id] == 0 && now.Sub(ts) > m.idleGrace {
					delete(m.last, id)
					idle = append(idle, id)
				}
			}
			m.mu.Unlock()
			for _, id := range idle {
				m.mu.Lock()
				_, active := m.last[id]
				m.mu.Unlock()
				if !active {
					go m.stopIdle(id)
				}
			}
		}
	}
}

func (m *Manager) stopIdle(id string) {
	if _, loaded := m.stopping.LoadOrStore(id, struct{}{}); loaded {
		return
	}
	defer m.stopping.Delete(id)
	m.mu.Lock()
	_, recent := m.last[id]
	active := m.active[id] > 0
	m.mu.Unlock()
	if recent || active {
		return
	}
	m.onIdle(id)
}
