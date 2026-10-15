package restream

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/aleskxyz/tgtv/internal/discovery"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type telegramRPC interface {
	target(context.Context) (*tg.InputPeerChannel, *tg.InputGroupCall, error)
	credentials(context.Context, *tg.InputPeerChannel) (string, error)
	create(context.Context, *tg.InputPeerChannel, int) (*tg.InputGroupCall, error)
	discard(context.Context, *tg.InputGroupCall) error
}
type ownership struct {
	ChannelID int64              `json:"channel_id"`
	Call      *tg.InputGroupCall `json:"call,omitempty"`
	RandomID  int                `json:"random_id"`
}
type TelegramDestination struct {
	mu    sync.Mutex
	path  string
	rpc   telegramRPC
	owned ownership
}

func newDestination(path string, rpc telegramRPC) (*TelegramDestination, error) {
	d := &TelegramDestination{path: path, rpc: rpc, owned: ownership{ChannelID: OutputChatID}}
	data, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(data, &d.owned); err != nil {
			return nil, err
		}
		if d.owned.ChannelID != OutputChatID {
			return nil, errors.New("ownership channel mismatch")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return d, nil
}
func NewTelegramDestination(path string, api *tg.Client, registry *discovery.Registry) (*TelegramDestination, error) {
	return newDestination(path, &gotdRPC{api: api, registry: registry})
}
func (d *TelegramDestination) Open(ctx context.Context) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	peer, current, err := d.rpc.target(ctx)
	if err != nil {
		return "", err
	}
	if current != nil && (d.owned.Call == nil || d.owned.Call.ID != current.ID || d.owned.Call.AccessHash != current.AccessHash) {
		return "", errors.New("destination has a call not owned by this service")
	}
	url, err := d.rpc.credentials(ctx, peer)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(url, "rtmp://") && !strings.HasPrefix(url, "rtmps://") {
		return "", errors.New("invalid RTMP credentials")
	}
	if current == nil {
		if d.owned.RandomID == 0 || d.owned.Call != nil {
			var b [4]byte
			if _, err = rand.Read(b[:]); err != nil {
				return "", err
			}
			d.owned = ownership{ChannelID: OutputChatID, RandomID: int(binary.LittleEndian.Uint32(b[:])&0x7fffffff) + 1}
		}
		if err = atomicJSON(d.path, d.owned); err != nil {
			return "", err
		}
		call, err := d.rpc.create(ctx, peer, d.owned.RandomID)
		if err != nil {
			return "", err
		}
		d.owned.Call = call
		if err = atomicJSON(d.path, d.owned); err != nil {
			return "", err
		}
	}
	return url, nil
}
func (d *TelegramDestination) Close(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.owned.Call == nil {
		return nil
	}
	_, current, err := d.rpc.target(ctx)
	if err != nil {
		return err
	}
	if current != nil && current.ID == d.owned.Call.ID && current.AccessHash == d.owned.Call.AccessHash {
		if err = d.rpc.discard(ctx, d.owned.Call); err != nil && !tgerr.Is(err, "GROUPCALL_INVALID", "GROUPCALL_ALREADY_DISCARDED") {
			return err
		}
	}
	d.owned = ownership{ChannelID: OutputChatID}
	return atomicJSON(d.path, d.owned)
}

type gotdRPC struct {
	api      *tg.Client
	registry *discovery.Registry
}

func (g *gotdRPC) target(ctx context.Context) (*tg.InputPeerChannel, *tg.InputGroupCall, error) {
	hash, ok := g.registry.ChannelAccessHash(OutputChatID)
	if !ok {
		return nil, nil, errors.New("output channel not discovered in joined dialogs yet")
	}
	full, err := g.api.ChannelsGetFullChannel(ctx, &tg.InputChannel{ChannelID: OutputChatID, AccessHash: hash})
	if err != nil {
		return nil, nil, err
	}
	allowed := false
	for _, ch := range full.Chats {
		if c, ok := ch.(*tg.Channel); ok && c.ID == OutputChatID {
			allowed = !c.Left && (c.Creator || c.AdminRights.ManageCall)
		}
	}
	if !allowed {
		return nil, nil, errors.New("output channel requires manage_call admin permission")
	}
	ch, ok := full.FullChat.(*tg.ChannelFull)
	if !ok {
		return nil, nil, errors.New("expected channel metadata")
	}
	var call *tg.InputGroupCall
	if input, ok := ch.GetCall(); ok {
		var valid bool
		call, valid = input.(*tg.InputGroupCall)
		if !valid {
			return nil, nil, errors.New("unexpected group call identity")
		}
	}
	return &tg.InputPeerChannel{ChannelID: OutputChatID, AccessHash: hash}, call, nil
}
func (g *gotdRPC) credentials(ctx context.Context, peer *tg.InputPeerChannel) (string, error) {
	v, err := g.api.PhoneGetGroupCallStreamRtmpURL(ctx, &tg.PhoneGetGroupCallStreamRtmpURLRequest{Peer: peer, Revoke: false})
	if err != nil {
		return "", err
	}
	return strings.TrimRight(v.URL, "/") + "/" + v.Key, nil
}
func (g *gotdRPC) create(ctx context.Context, peer *tg.InputPeerChannel, id int) (*tg.InputGroupCall, error) {
	updates, err := g.api.PhoneCreateGroupCall(ctx, &tg.PhoneCreateGroupCallRequest{Peer: peer, RandomID: id, RtmpStream: true})
	if err != nil {
		return nil, err
	}
	var list []tg.UpdateClass
	switch u := updates.(type) {
	case *tg.Updates:
		list = u.Updates
	case *tg.UpdatesCombined:
		list = u.Updates
	}
	var found *tg.InputGroupCall
	for _, u := range list {
		if v, ok := u.(*tg.UpdateGroupCall); ok && !v.LiveStory {
			if peer, ok := v.Peer.(*tg.PeerChannel); ok && peer.ChannelID != OutputChatID {
				continue
			}
			if call, ok := v.Call.(*tg.GroupCall); ok && call.RtmpStream {
				if found != nil {
					return nil, errors.New("ambiguous created call")
				}
				found = &tg.InputGroupCall{ID: call.ID, AccessHash: call.AccessHash}
			}
		}
	}
	if found == nil {
		return nil, fmt.Errorf("Telegram returned no unique created RTMP call")
	}
	return found, nil
}
func (g *gotdRPC) discard(ctx context.Context, call *tg.InputGroupCall) error {
	_, err := g.api.PhoneDiscardGroupCall(ctx, call)
	return err
}
