package restream

import (
	"context"
	"errors"
	"github.com/gotd/td/tgerr"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeBackend struct {
	sources             []Source
	err                 error
	ready               bool
	starts, stops, ends int
	running             bool
	fail                bool
}

func (f *fakeBackend) Sources(context.Context) ([]Source, error)     { return f.sources, f.err }
func (f *fakeBackend) Prepare(context.Context, Source) (bool, error) { return f.ready, nil }
func (f *fakeBackend) Open(context.Context) (string, error) {
	f.starts++
	return "rtmps://example/key", nil
}
func (f *fakeBackend) Close(context.Context) error { f.ends++; return nil }
func (f *fakeBackend) Start(context.Context, Source, string) error {
	if f.fail {
		return errors.New("failed")
	}
	f.running = true
	return nil
}
func (f *fakeBackend) Stop()                  { f.stops++; f.running = false }
func (f *fakeBackend) Healthy(time.Time) bool { return f.running }
func source(id string, chat int64) Source     { return Source{ID: id, ChatID: chat, Title: id, Live: true} }
func setup(t *testing.T) (*Controller, *fakeBackend) {
	t.Helper()
	f := &fakeBackend{ready: true}
	c, err := NewController(filepath.Join(t.TempDir(), "controls.json"), f, f, f)
	if err != nil {
		t.Fatal(err)
	}
	return c, f
}
func tick(c *Controller, n int) { c.Step(context.Background(), time.Unix(int64(n), 0)) }

func TestTurboPreemptsEligibleFallbackWithoutClosingCall(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("free", 2291644480)}
	if err := c.Control(Controls{Auto: true, Fallbacks: []string{"free"}}); err != nil {
		t.Fatal(err)
	}
	tick(c, 100)
	if c.Snapshot().Active != "free" {
		t.Fatal(c.Snapshot())
	}
	f.sources = append(f.sources, source("turbo", TurboChatID))
	tick(c, 101)
	if c.Snapshot().Active != "turbo" || f.ends != 0 || f.starts != 1 {
		t.Fatal(c.Snapshot(), f)
	}
	f.sources = nil
	tick(c, 102)
	if c.Snapshot().Active != "" || f.ends != 1 {
		t.Fatal(c.Snapshot(), f)
	}
}
func TestOnlyExplicitFallbacksAndNeverOutput(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("out", OutputChatID), source("free", 2291644480)}
	tick(c, 100)
	if c.Snapshot().Active != "" {
		t.Fatal("unapproved fallback started")
	}
	_ = c.Control(Controls{Auto: true, Fallbacks: []string{"out", "free"}})
	tick(c, 101)
	if c.Snapshot().Active != "free" {
		t.Fatal(c.Snapshot())
	}
}
func TestForcedOfflineDoesNotSubstitute(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID)}
	_ = c.Control(Controls{Auto: true, Forced: "rwitc"})
	tick(c, 100)
	if f.starts != 0 {
		t.Fatal("forced source unavailable, must idle")
	}
}
func TestPausePersistsAndEndsCall(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID)}
	tick(c, 100)
	if err := c.Control(Controls{Auto: true, Paused: true}); err != nil {
		t.Fatal(err)
	}
	tick(c, 101)
	restored, err := NewController(c.statePath, f, f, f)
	if err != nil || !restored.Snapshot().Controls.Paused || f.ends != 1 {
		t.Fatal(err, f)
	}
}
func TestFailedDiscoveryKeepsBroadcastAndRecordsError(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID)}
	tick(c, 100)
	f.err = errors.New("discovery unavailable")
	tick(c, 101)
	if c.Snapshot().Active != "turbo" || f.ends != 0 || c.Snapshot().Error == "" {
		t.Fatal(c.Snapshot(), f)
	}
}
func TestRetryBackoffAndUnreadyCapture(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID)}
	f.ready = false
	tick(c, 100)
	if f.starts != 0 {
		t.Fatal("call created before media ready")
	}
	f.ready = true
	f.fail = true
	tick(c, 101)
	starts := f.starts
	tick(c, 102)
	if f.starts != starts || c.Snapshot().RetryAt.IsZero() {
		t.Fatal("retry not delayed")
	}
	f.fail = false
	tick(c, 140)
	if c.Snapshot().Active != "turbo" {
		t.Fatal(c.Snapshot())
	}
}
func TestControlWriteFailureDoesNotChangeMemory(t *testing.T) {
	c, _ := setup(t)
	c.statePath = filepath.Join(t.TempDir(), "missing", "controls.json")
	if c.Control(Controls{Paused: true}) == nil || c.Snapshot().Controls.Paused {
		t.Fatal("failed write changed controls")
	}
}

func TestUnhealthyPrimaryFallsBackThenRecovers(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID), source("free", 2291644480)}
	_ = c.Control(Controls{Auto: true, Fallbacks: []string{"free"}})
	tick(c, 100)
	f.running = false
	tick(c, 101)
	tick(c, 105)
	if c.Snapshot().Active != "free" {
		t.Fatal("failed primary did not yield to fallback", c.Snapshot())
	}
	tick(c, 140)
	if c.Snapshot().Active != "turbo" {
		t.Fatal("primary not retried", c.Snapshot())
	}
}

func TestPausedControllerStillRefreshesPreviews(t *testing.T) {
	c, f := setup(t)
	_ = c.Control(Controls{Auto: true, Paused: true})
	f.sources = []Source{source("turbo", TurboChatID)}
	tick(c, 100)
	if len(c.Snapshot().Sources) != 1 || c.Snapshot().Phase != "paused" || f.starts != 0 {
		t.Fatal(c.Snapshot())
	}
}
func TestUnreadyPrimaryYieldsAfterStartupDeadline(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("turbo", TurboChatID), source("free", 2291644480)}
	_ = c.Control(Controls{Auto: true, Fallbacks: []string{"free"}})
	f.ready = false
	tick(c, 100)
	tick(c, 125)
	f.ready = true
	tick(c, 130)
	if c.Snapshot().Active != "free" {
		t.Fatal(c.Snapshot())
	}
}

func TestFloodWaitDefersNextRPC(t *testing.T) {
	c, f := setup(t)
	f.err = tgerr.New(420, "FLOOD_WAIT_120")
	tick(c, 100)
	if c.Snapshot().RetryAt.Before(time.Unix(220, 0)) {
		t.Fatal("server flood wait was ignored", c.Snapshot())
	}
}

func TestManualMediaRetryKeepsCallAndRecoversWithoutSourceCooldown(t *testing.T) {
	c, f := setup(t)
	f.sources = []Source{source("test-hls", 0)}
	if err := c.Control(Controls{Auto: true, Forced: "test-hls"}); err != nil {
		t.Fatal(err)
	}
	tick(c, 100)
	f.running = false // a temporary sender exit while the chosen feed remains live
	tick(c, 101)
	tick(c, 103)
	if got := c.Snapshot(); got.Active != "test-hls" || got.Phase != "live" || f.ends != 0 {
		t.Fatalf("manual recovery must reuse the call after short backoff, got %+v closes=%d", got, f.ends)
	}
}

type mediaWithReason struct{ *fakeBackend }

func (mediaWithReason) Failure() string { return "cannot connect publishing output" }
func TestControllerReportsSafeMediaFailureStage(t *testing.T) {
	c, f := setup(t)
	c.media = mediaWithReason{f}
	f.sources = []Source{source("test-hls", 0)}
	_ = c.Control(Controls{Auto: true, Forced: "test-hls"})
	tick(c, 100)
	f.running = false
	tick(c, 101)
	if !strings.Contains(c.Snapshot().Error, "cannot connect publishing output") {
		t.Fatal("sender failure stage missing", c.Snapshot().Error)
	}
}
