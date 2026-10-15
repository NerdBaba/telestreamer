package restream

import (
	"context"
	"github.com/gotd/td/tg"
	"path/filepath"
	"testing"
)

type fakeTelegram struct {
	current  *tg.InputGroupCall
	discards int
	creates  int
}

func (f *fakeTelegram) target(context.Context) (*tg.InputPeerChannel, *tg.InputGroupCall, error) {
	return &tg.InputPeerChannel{ChannelID: OutputChatID}, f.current, nil
}
func (f *fakeTelegram) credentials(context.Context, *tg.InputPeerChannel) (string, error) {
	return "rtmps://example/key", nil
}
func (f *fakeTelegram) create(context.Context, *tg.InputPeerChannel, int) (*tg.InputGroupCall, error) {
	f.creates++
	f.current = &tg.InputGroupCall{ID: 42, AccessHash: 99}
	return f.current, nil
}
func (f *fakeTelegram) discard(context.Context, *tg.InputGroupCall) error {
	f.discards++
	f.current = nil
	return nil
}
func TestDestinationRejectsUnownedCall(t *testing.T) {
	f := &fakeTelegram{current: &tg.InputGroupCall{ID: 7}}
	d, err := newDestination(filepath.Join(t.TempDir(), "owned.json"), f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.Open(context.Background()); err == nil {
		t.Fatal("adopted foreign call")
	}
	if err = d.Close(context.Background()); err != nil || f.discards != 0 {
		t.Fatal(err, f)
	}
}
func TestDestinationRecoversOwnedCallAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owned.json")
	f := &fakeTelegram{}
	d, _ := newDestination(path, f)
	if _, err := d.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	d, err := newDestination(path, f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.Open(context.Background()); err != nil || f.creates != 1 {
		t.Fatal(err, f)
	}
	if err = d.Close(context.Background()); err != nil || f.discards != 1 {
		t.Fatal(err, f)
	}
}
func TestDestinationDoesNotDiscardReplacement(t *testing.T) {
	f := &fakeTelegram{}
	d, _ := newDestination(filepath.Join(t.TempDir(), "owned.json"), f)
	_, _ = d.Open(context.Background())
	f.current = &tg.InputGroupCall{ID: 80}
	if err := d.Close(context.Background()); err != nil || f.discards != 0 {
		t.Fatal(err, f)
	}
}
