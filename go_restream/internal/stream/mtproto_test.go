package stream

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type closeTrackingInvoker struct {
	closed atomic.Int32
}

type floodTrackingInvoker struct{ calls atomic.Int32 }

func (c *floodTrackingInvoker) Invoke(context.Context, bin.Encoder, bin.Decoder) error {
	c.calls.Add(1)
	return tgerr.New(420, "FLOOD_WAIT_3")
}

func TestStreamChannelFloodWaitBlocksRepeatedRPCs(t *testing.T) {
	inv := &floodTrackingInvoker{}
	mt := NewMTProto(tg.NewClient(inv), nil)
	ctx := context.Background()
	call := tg.InputGroupCall{ID: 1, AccessHash: 2}
	if _, err := mt.PhoneGetGroupCallStreamChannels(ctx, 5, call); err == nil {
		t.Fatal("expected server backoff")
	}
	first, _ := mt.StreamDCWaitRemaining(5)
	if _, err := mt.PhoneGetGroupCallStreamChannels(ctx, 5, call); err == nil {
		t.Fatal("expected retained backoff")
	}
	second, _ := mt.StreamDCWaitRemaining(5)
	if inv.calls.Load() != 1 {
		t.Fatal("retried Telegram before its backoff expired", inv.calls.Load())
	}
	if second > first {
		t.Fatal("extended the server deadline by retrying locally")
	}
}

func (c *closeTrackingInvoker) Invoke(_ context.Context, _ bin.Encoder, _ bin.Decoder) error {
	return errors.New("mock invoker")
}

func (c *closeTrackingInvoker) Close() error {
	c.closed.Add(1)
	return nil
}

func TestMTProtoCloseReleasesPools(t *testing.T) {
	inv1 := &closeTrackingInvoker{}
	inv2 := &closeTrackingInvoker{}
	mt := &MTProto{
		dcClients: map[int]*dcConn{
			4: {client: tg.NewClient(inv1), invoker: inv1},
			5: {client: tg.NewClient(inv2), invoker: inv2},
		},
		dcWait: map[int]time.Time{4: time.Now().Add(time.Minute)},
	}

	mt.Close()

	if got := inv1.closed.Load(); got != 1 {
		t.Fatalf("dc 4 invoker close count=%d", got)
	}
	if got := inv2.closed.Load(); got != 1 {
		t.Fatalf("dc 5 invoker close count=%d", got)
	}
	if mt.dcClients != nil {
		t.Fatal("expected dcClients cleared")
	}
	if mt.dcWait != nil {
		t.Fatal("expected dcWait cleared")
	}
}
