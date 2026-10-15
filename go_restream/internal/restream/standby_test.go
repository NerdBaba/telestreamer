package restream

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStandbyExposesOnlyHealthWithoutSession(t *testing.T) {
	t.Setenv("SESSION_JSON_B64", "invalid-session-must-not-be-read")
	for _, path := range []string{"/health", "/healthz", "/api/status", "/", "/output/index.m3u8"} {
		w := httptest.NewRecorder()
		standbyHTTP(w, httptest.NewRequest("GET", path, nil))
		if strings.HasPrefix(path, "/health") {
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"telegram_connected":false`) {
				t.Fatal(path, w.Code, w.Body.String())
			}
		} else if w.Code != 503 {
			t.Fatal(path, w.Code)
		}
		if strings.Contains(w.Body.String(), "invalid-session") {
			t.Fatal("secret exposed")
		}
	}
}
