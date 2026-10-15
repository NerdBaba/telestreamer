package restream

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/aleskxyz/tgtv/internal/discovery"

	"github.com/aleskxyz/tgtv/internal/viewer"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type callCheck struct {
	id     int64
	at     time.Time
	live   bool
	detail string
}
type callAPI interface {
	PhoneGetGroupCall(context.Context, *tg.PhoneGetGroupCallRequest) (*tg.PhoneGroupCall, error)
}
type ingestBackend interface {
	IsRecoveryFailed(string) bool
	IsIngesting(string) bool
	StopIngest(string)
	EnsureIngest(context.Context, string) error
	IsReady(context.Context, string) bool
}
type Capture struct {
	prepared string
	API      callAPI
	Registry *discovery.Registry
	Ingest   ingestBackend
	Viewers  *viewer.Manager
	BaseURL  string
	mu       sync.RWMutex
	rwitc    Source
	mysore   Source
	checks   map[string]callCheck
}

func (d *Capture) PollOfficialStreams(ctx context.Context) {
	var wg sync.WaitGroup
	for _, provider := range []struct {
		id, title string
		resolve   func(context.Context) (Source, error)
	}{{"rwitc", "RWITC Official", (RWITC{}).Resolve}, {"mysore", "Mysore Race Club", (Mysore{}).Resolve}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				probe, cancel := context.WithTimeout(ctx, 20*time.Second)
				s, err := provider.resolve(probe)
				cancel()
				if err != nil {
					s = Source{ID: provider.id, Title: provider.title, Detail: "Provider unavailable; checking again"}
				}
				d.mu.Lock()
				current := &d.rwitc
				if provider.id == "mysore" {
					current = &d.mysore
				}
				if err != nil && current.Live {
					current.Detail = "Discovery unavailable; retaining last verified feed"
				} else {
					*current = s
				}
				d.mu.Unlock()
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	}
	wg.Wait()
}
func (d *Capture) Sources(ctx context.Context) ([]Source, error) {
	if d.checks == nil {
		d.checks = make(map[string]callCheck)
	}
	entries := d.Registry.ActiveLives()
	rows := make([]Source, 0, len(entries)+2)
	turbo := false
	for _, e := range entries {
		if e.ChatID == OutputChatID {
			continue
		}
		if e.ChatID == TurboChatID {
			turbo = true
		}
		cached, ok := d.checks[e.StreamID]
		if !ok || cached.id != e.CallID || time.Since(cached.at) > 5*time.Second {
			info, err := d.API.PhoneGetGroupCall(ctx, &tg.PhoneGetGroupCallRequest{Call: &tg.InputGroupCall{ID: e.CallID, AccessHash: e.CallAccessHash}, Limit: 1})
			if err != nil {
				if _, wait := tgerr.AsFloodWait(err); wait {
					return nil, err
				}
				if tgerr.Is(err, "GROUPCALL_INVALID", "GROUPCALL_ALREADY_DISCARDED") {
					cached = callCheck{id: e.CallID, at: time.Now(), detail: "Broadcast ended"}
				} else {
					cached.id = e.CallID
					cached.at = time.Now()
					cached.detail = "Call metadata unavailable; checking again"
				}
			} else {
				call, ok := info.Call.(*tg.GroupCall)
				cached = callCheck{id: e.CallID, at: time.Now(), detail: "Not an RTMP broadcast"}
				if ok {
					cached.live = call.RtmpStream && call.ScheduleDate == 0
					if cached.live {
						cached.detail = "Live Telegram broadcast"
					} else if call.ScheduleDate != 0 {
						cached.detail = "Scheduled"
					}
				}
			}
			d.checks[e.StreamID] = cached
		}
		live := cached.live && !d.Ingest.IsRecoveryFailed(e.StreamID)
		if cached.live && !live {
			cached.detail = "Capture recovering"
		}
		rows = append(rows, Source{ID: e.StreamID, ChatID: e.ChatID, Title: e.Title, Live: live, Detail: cached.detail, URL: fmt.Sprintf("%s/streams/%s/play.m3u8", d.BaseURL, e.StreamID)})
	}
	// Registry entries disappear when confirmed ended; keep the primary visible.
	if !turbo {
		rows = append(rows, Source{ID: discovery.MakeStreamID(TurboChatID), ChatID: TurboChatID, Title: "TurboSportsLive", Detail: "Waiting for a broadcast"})
	}
	d.mu.RLock()
	official := d.rwitc
	mysore := d.mysore
	d.mu.RUnlock()
	if official.ID == "" {
		official = Source{ID: "rwitc", Title: "RWITC Official", Detail: "Checking official stream"}
	}
	if mysore.ID == "" {
		mysore = Source{ID: "mysore", Title: "Mysore Race Club", Detail: "Checking official stream"}
	}
	rows = append(rows, official, mysore)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].ChatID == TurboChatID {
			return true
		}
		if rows[j].ChatID == TurboChatID {
			return false
		}
		return rows[i].Title < rows[j].Title
	})
	active := make(map[string]bool)
	for _, e := range entries {
		active[e.StreamID] = true
	}
	for id := range d.checks {
		if !active[id] {
			delete(d.checks, id)
		}
	}
	return rows, nil
}
func (d *Capture) Prepare(ctx context.Context, s Source) (bool, error) {
	if s.ID == "rwitc" || s.ID == "mysore" {
		return s.Live, nil
	}
	// Reclaim abandoned previews while retaining the previous outgoing input
	// until the replacement has buffered. The UI opens one preview at a time.
	for _, e := range d.Registry.ActiveLives() {
		if e.StreamID != s.ID && e.StreamID != d.prepared && d.Ingest.IsIngesting(e.StreamID) {
			d.Ingest.StopIngest(e.StreamID)
		}
	}
	d.Viewers.RecordActivity(s.ID)
	if err := d.Ingest.EnsureIngest(ctx, s.ID); err != nil {
		return false, err
	}
	ready := d.Ingest.IsReady(ctx, s.ID)
	if ready {
		d.prepared = s.ID
	}
	return ready, nil
}
