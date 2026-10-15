package restream

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gotd/td/session"
)

func TestOfflineSessionImportAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "export.json")
	dest := filepath.Join(dir, "tgtv.json")
	data, _ := json.Marshal(map[string]any{"dc_id": 2, "server_address": "149.154.167.51", "port": 443, "auth_key": base64.StdEncoding.EncodeToString(make([]byte, 256))})
	_ = os.WriteFile(source, data, 0600)
	if err := ImportSession(source, dest); err != nil {
		t.Fatal(err)
	}
	loader := session.Loader{Storage: &session.FileStorage{Path: dest}}
	parsed, err := loader.Load(context.Background())
	if err != nil || parsed.DC != 2 || len(parsed.AuthKey) != 256 || len(parsed.AuthKeyID) != 8 {
		t.Fatal(parsed, err)
	}
	stat, _ := os.Stat(dest)
	if stat.Mode().Perm() != 0600 {
		t.Fatal(stat.Mode())
	}
	if err := ImportSession(source, dest); err == nil {
		t.Fatal("overwrote session")
	}
}
