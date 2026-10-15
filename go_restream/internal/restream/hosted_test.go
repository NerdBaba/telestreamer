package restream

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRemoteStateSurvivesMissingLocalDisk(t *testing.T) {
	values := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-state-token" {
			t.Error("missing auth")
		}
		key := r.URL.Path
		if r.Method == "PUT" {
			var v json.RawMessage
			if json.NewDecoder(r.Body).Decode(&v) != nil {
				t.Error("invalid JSON")
			}
			values[key] = v
			w.WriteHeader(204)
			return
		}
		if v, ok := values[key]; ok {
			_, _ = w.Write(v)
		} else {
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	t.Setenv("STATE_URL", server.URL)
	t.Setenv("STATE_TOKEN", "test-state-token")
	path := filepath.Join(t.TempDir(), "absent", "controls.json")
	if err := atomicJSON(path, Controls{Paused: true}); err != nil {
		t.Fatal(err)
	}
	data, err := readState(path)
	if err != nil {
		t.Fatal(err)
	}
	var v Controls
	_ = json.Unmarshal(data, &v)
	if !v.Paused {
		t.Fatal(v)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("remote state depends on local disk")
	}
}
func TestRestoreHostedSessionRejectsInvalidAndPreservesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tgtv.json")
	t.Setenv("SESSION_JSON_B64", base64.StdEncoding.EncodeToString([]byte(`{"Version":1,"Data":{}}`)))
	if RestoreHostedSession(path) == nil {
		t.Fatal("invalid auth key accepted")
	}
	_ = os.WriteFile(path, []byte("existing"), 0600)
	if err := RestoreHostedSession(path); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "existing" {
		t.Fatal("overwrote existing session")
	}
}
func TestLeaseRefusesSecondOwner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "busy", 409) }))
	defer server.Close()
	t.Setenv("STATE_URL", server.URL)
	t.Setenv("STATE_TOKEN", "token")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := AcquireHostedLease(ctx, func() {}); err == nil {
		t.Fatal("lease acquired while cancelled")
	}
}
