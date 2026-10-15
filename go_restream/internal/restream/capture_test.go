package restream

import (
	"context"
	"errors"
	"github.com/aleskxyz/tgtv/internal/discovery"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"testing"
)

type captureAPI struct {
	fail  map[int64]error
	calls map[int64]tg.GroupCallClass
}

func (a captureAPI) PhoneGetGroupCall(ctx context.Context, r *tg.PhoneGetGroupCallRequest) (*tg.PhoneGroupCall, error) {
	id := r.Call.(*tg.InputGroupCall).ID
	if err := a.fail[id]; err != nil {
		return nil, err
	}
	return &tg.PhoneGroupCall{Call: a.calls[id]}, nil
}

type captureIngest struct{}

func (captureIngest) IsRecoveryFailed(string) bool               { return false }
func (captureIngest) IsIngesting(string) bool                    { return false }
func (captureIngest) StopIngest(string)                          {}
func (captureIngest) EnsureIngest(context.Context, string) error { return nil }
func (captureIngest) IsReady(context.Context, string) bool       { return true }
func TestCaptureIsolatesUnrelatedMetadataErrors(t *testing.T) {
	reg := discovery.NewRegistry()
	reg.Upsert(TurboChatID, 1, "Turbo", 11)
	reg.Upsert(2291644480, 2, "Other", 22)
	d := Capture{Registry: reg, Ingest: captureIngest{}, API: captureAPI{fail: map[int64]error{2: errors.New("inaccessible")}, calls: map[int64]tg.GroupCallClass{1: &tg.GroupCall{RtmpStream: true}}}}
	rows, err := d.Sources(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if chosen := choose(rows, Controls{Auto: true}); chosen == nil || chosen.ChatID != TurboChatID {
		t.Fatal(rows)
	}
}
func TestCaptureHonorsFloodWaitAndConfirmedEnd(t *testing.T) {
	reg := discovery.NewRegistry()
	reg.Upsert(TurboChatID, 1, "Turbo", 11)
	d := Capture{Registry: reg, Ingest: captureIngest{}, API: captureAPI{fail: map[int64]error{1: tgerr.New(420, "FLOOD_WAIT_120")}}}
	if _, err := d.Sources(context.Background()); err == nil {
		t.Fatal("flood wait swallowed")
	}
	d.API = captureAPI{fail: map[int64]error{1: tgerr.New(400, "GROUPCALL_INVALID")}}
	rows, err := d.Sources(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if choose(rows, Controls{Auto: true}) != nil {
		t.Fatal("ended call eligible")
	}
}
func TestScheduledAndPhoneCallsNeverEligible(t *testing.T) {
	for _, call := range []tg.GroupCallClass{&tg.GroupCall{}, &tg.GroupCall{RtmpStream: true, ScheduleDate: 123}, &tg.GroupCallDiscarded{}} {
		reg := discovery.NewRegistry()
		reg.Upsert(TurboChatID, 1, "Turbo", 11)
		d := Capture{Registry: reg, Ingest: captureIngest{}, API: captureAPI{calls: map[int64]tg.GroupCallClass{1: call}}}
		rows, err := d.Sources(context.Background())
		if err != nil || choose(rows, Controls{Auto: true}) != nil {
			t.Fatal(rows, err)
		}
	}
}
