package restream

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/gotd/td/session"
)

// ImportSession converts an offline exported Telethon JSON into gotd's native
// format without dialing Telegram. The source must be exported after stopping
// its former holder; a local file lock cannot enforce cross-host exclusivity.
func ImportSession(source, destination string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("cannot read session export")
	}
	var raw struct {
		DC     int    `json:"dc_id"`
		Server string `json:"server_address"`
		Port   int    `json:"port"`
		Key    string `json:"auth_key"`
	}
	if err = json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("invalid session export")
	}
	key, err := base64.StdEncoding.DecodeString(raw.Key)
	if err != nil || len(key) != 256 || raw.DC < 1 || raw.DC > 5 || net.ParseIP(raw.Server) == nil || raw.Port < 1 || raw.Port > 65535 {
		return fmt.Errorf("invalid session export fields")
	}
	// TelethonSession computes the auth key ID exactly as the client expects.
	ip := net.ParseIP(raw.Server)
	ipBytes := ip.To4()
	if ipBytes == nil {
		ipBytes = ip.To16()
	}
	packed := append([]byte{byte(raw.DC)}, ipBytes...)
	packed = append(packed, byte(raw.Port>>8), byte(raw.Port))
	packed = append(packed, key...)
	parsed, err := session.TelethonSession("1" + base64.URLEncoding.EncodeToString(packed))
	if err != nil {
		return fmt.Errorf("invalid session key")
	}
	encoded, err := json.Marshal(struct {
		Version int
		Data    *session.Data
	}{1, parsed})
	if err != nil {
		return err
	}
	// Never overwrite an existing authorized session.
	f, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("destination exists or is unwritable")
	}
	_, err = f.Write(encoded)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(destination)
		return fmt.Errorf("session write failed")
	}
	for i := range key {
		key[i] = 0
	}
	raw.Key = strings.Repeat("0", len(raw.Key))
	return nil
}
