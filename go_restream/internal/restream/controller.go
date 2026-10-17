// Package restream implements the single-writer broadcast lifecycle.
package restream

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/gotd/td/tgerr"
)

const TurboChatID int64 = 2961901881
const OutputChatID int64 = 4347395930

type Source struct {
	ID      string `json:"id"`
	ChatID  int64  `json:"chat_id,omitempty"`
	Title   string `json:"title"`
	Live    bool   `json:"live"`
	Detail  string `json:"detail"`
	URL     string `json:"-"`
	Headers string `json:"-"`
	TestURL string `json:"test_url,omitempty"`
}
type Controls struct {
	Auto      bool     `json:"auto"`
	Paused    bool     `json:"paused"`
	Forced    string   `json:"forced"`
	Fallbacks []string `json:"fallbacks"`
}
type Event struct {
	Time   time.Time `json:"time"`
	Detail string    `json:"detail"`
}
type Status struct {
	Controls  Controls  `json:"controls"`
	Sources   []Source  `json:"sources"`
	Active    string    `json:"active"`
	Phase     string    `json:"phase"`
	Error     string    `json:"error"`
	RetryAt   time.Time `json:"retry_at"`
	CheckedAt time.Time `json:"checked_at"`
	Events    []Event   `json:"events"`
	Demo      bool      `json:"demo"`
}
type Discovery interface {
	Sources(context.Context) ([]Source, error)
	Prepare(context.Context, Source) (bool, error)
}
type Destination interface {
	Open(context.Context) (string, error)
	Close(context.Context) error
}
type Media interface {
	Start(context.Context, Source, string) error
	Stop()
	Healthy(time.Time) bool
}
type Controller struct {
	mu             sync.RWMutex
	stepMu         sync.Mutex
	statePath      string
	status         Status
	discovery      Discovery
	destination    Destination
	media          Media
	destinationURL string
	closePending   bool
	failures       uint
	wake           chan struct{}
	cooldown       map[string]time.Time
	warming        map[string]time.Time
}

func NewController(path string, d Discovery, p Destination, m Media) (*Controller, error) {
	c := &Controller{statePath: path, discovery: d, destination: p, media: m, wake: make(chan struct{}, 1)}
	c.status = Status{Controls: Controls{Auto: true, Fallbacks: []string{}}, Sources: []Source{}, Phase: "idle", Events: []Event{}}
	data, err := readState(path)
	if err == nil {
		if err = json.Unmarshal(data, &c.status.Controls); err != nil {
			return nil, fmt.Errorf("invalid controls state: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return c, nil
}
func atomicJSON(path string, v any) error {
	if os.Getenv("STATE_URL") != "" && remoteKey(path) != "" {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = stateRequest(context.Background(), "PUT", remoteKey(path), data)
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".state-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (c *Controller) Control(v Controls) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(v.Forced) > 64 || len(v.Fallbacks) > 128 {
		return fmt.Errorf("too many or invalid sources")
	}
	v.Fallbacks = slices.Clone(v.Fallbacks)
	if err := atomicJSON(c.statePath, v); err != nil {
		return err
	}
	c.status.Controls = v
	c.status.RetryAt = time.Time{}
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return nil
}
func (c *Controller) Snapshot() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()
	s := c.status
	s.Controls.Fallbacks = slices.Clone(s.Controls.Fallbacks)
	s.Sources = slices.Clone(s.Sources)
	s.Events = slices.Clone(s.Events)
	return s
}
func (c *Controller) note(detail string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.Events = append(c.status.Events, Event{Time: time.Now().UTC(), Detail: detail})
	if len(c.status.Events) > 60 {
		c.status.Events = c.status.Events[len(c.status.Events)-60:]
	}
}
func (c *Controller) set(phase, active, err string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.Phase = phase
	c.status.Active = active
	c.status.Error = err
}
func choose(rows []Source, v Controls) *Source {
	if v.Paused || !v.Auto {
		return nil
	}
	valid := func(s Source) bool { return s.Live && s.ChatID != OutputChatID }
	if v.Forced != "" {
		for _, s := range rows {
			if s.ID == v.Forced && valid(s) {
				return &s
			}
		}
		return nil
	}
	for _, s := range rows {
		if s.ChatID == TurboChatID && valid(s) {
			return &s
		}
	}
	for _, id := range v.Fallbacks {
		if isTestSource(id) {
			continue
		}
		for _, s := range rows {
			if s.ID == id && valid(s) {
				return &s
			}
		}
	}
	return nil
}
func (c *Controller) fail(now time.Time, detail string, causes ...error) {
	c.failures++
	delay := time.Second * time.Duration(1<<min(c.failures, 5))
	c.mu.Lock()
	c.status.Error = detail
	c.status.Phase = "retrying"
	c.status.RetryAt = now.Add(delay)
	for _, cause := range causes {
		if wait, ok := tgerr.AsFloodWait(cause); ok && wait > delay {
			c.status.RetryAt = now.Add(wait)
		}
	}
	c.mu.Unlock()
	c.note(detail)
}
func (c *Controller) end(ctx context.Context) error {
	c.media.Stop()
	c.set("idle", "", "")
	// Close also reconciles the journal after a process restart, before Open.
	if err := c.destination.Close(ctx); err != nil {
		c.closePending = true
		return err
	}
	c.closePending = false
	c.destinationURL = ""
	return nil
}
func (c *Controller) Step(ctx context.Context, now time.Time) {
	c.stepMu.Lock()
	defer c.stepMu.Unlock()
	s := c.Snapshot()
	if now.Before(s.RetryAt) {
		return
	}
	if s.Controls.Paused || !s.Controls.Auto {
		if err := c.end(ctx); err != nil {
			c.fail(now, "could not end owned Telegram call", err)
		} else {
			c.set("paused", "", "")
			if rows, err := c.discovery.Sources(ctx); err == nil {
				c.mu.Lock()
				c.status.Sources = slices.Clone(rows)
				c.status.CheckedAt = now
				c.mu.Unlock()
			} else {
				c.fail(now, "source discovery unavailable", err)
			}
		}
		return
	}

	if c.closePending {
		if err := c.end(ctx); err != nil {
			c.fail(now, "could not end owned Telegram call", err)
			return
		}
	}
	rows, err := c.discovery.Sources(ctx)
	if err != nil {
		c.fail(now, "source discovery unavailable", err)
		return
	}
	c.mu.Lock()
	c.status.Sources = slices.Clone(rows)
	c.status.CheckedAt = now
	c.mu.Unlock()
	eligible := slices.Clone(rows)
	for i := range eligible {
		// A manual choice has no alternative to yield to. Retry it with the
		// normal short backoff instead of closing the call for 30 seconds.
		if eligible[i].ID != s.Controls.Forced && now.Before(c.cooldown[eligible[i].ID]) {
			eligible[i].Live = false
		}
	}
	target := choose(eligible, s.Controls)
	if target == nil {
		if s.Active != "" {
			c.note("Live sources ended; closing output")
		}
		if err := c.end(ctx); err != nil {
			c.fail(now, "could not end owned Telegram call", err)
		}
		return
	}
	if target.ID == s.Active && c.media.Healthy(now) {
		c.set("live", target.ID, "")
		return
	}
	if target.ID == s.Active {
		detail := "publishing stopped or media stalled"
		if reporter, ok := c.media.(interface{ Failure() string }); ok {
			if reason := reporter.Failure(); reason != "" {
				detail += ": " + reason
			}
		}
		c.cool(target.ID, now)
		c.destinationURL = ""
		c.media.Stop()
		c.set("retrying", "", "")
		c.fail(now, detail)
		return
	}
	c.set("starting", s.Active, "")
	ready, err := c.discovery.Prepare(ctx, *target)
	if err != nil {
		c.cool(target.ID, now)
		c.fail(now, "source capture could not start", err)
		return
	}
	if !ready {
		if c.warming == nil {
			c.warming = make(map[string]time.Time)
		}
		if began, ok := c.warming[target.ID]; ok {
			if now.Sub(began) >= 20*time.Second {
				delete(c.warming, target.ID)
				c.cool(target.ID, now)
				c.fail(now, "source capture readiness timed out")
			}
		} else {
			c.warming[target.ID] = now
		}
		return
	}
	delete(c.warming, target.ID)
	c.media.Stop()
	c.set("starting", "", "")
	if c.destinationURL == "" {
		c.destinationURL, err = c.destination.Open(ctx)
		if err != nil {
			c.fail(now, "Telegram destination unavailable; inspect destination call and permissions", err)
			return
		}
	}
	if err = c.media.Start(ctx, *target, c.destinationURL); err != nil {
		c.cool(target.ID, now)
		c.fail(now, "publishing could not start", err)
		return
	}
	c.failures = 0
	c.mu.Lock()
	c.status.RetryAt = time.Time{}
	c.mu.Unlock()
	c.set("live", target.ID, "")
	c.note("Publishing " + target.Title)
}
func (c *Controller) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		stepCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
		c.Step(stepCtx, time.Now().UTC())
		cancel()
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			c.stepMu.Lock()
			_ = c.end(shutdown)
			c.stepMu.Unlock()
			cancel()
			return
		case <-ticker.C:
		case <-c.wake:
		}
	}
}

func (c *Controller) cool(id string, now time.Time) {
	if c.cooldown == nil {
		c.cooldown = make(map[string]time.Time)
	}
	c.cooldown[id] = now.Add(30 * time.Second)
}
