package remux

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestUnifiedH264MP4PreservesDecodedFrames(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "part.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1",
		"-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an", input)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate: %v: %s", err, out)
	}
	payload, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	result, err := PayloadToMPEGTS("mp4", payload, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "part.ts")
	if err := os.WriteFile(output, result.MPEGTS, 0600); err != nil {
		t.Fatal(err)
	}
	hashes := func(path string) []string {
		t.Helper()
		out, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-").Output()
		if err != nil {
			t.Fatal(err)
		}
		var rows []string
		for _, line := range strings.Split(string(out), "\n") {
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Split(line, ",")
			rows = append(rows, strings.TrimSpace(fields[len(fields)-1]))
		}
		return rows
	}
	want, got := hashes(input), hashes(output)
	if len(want) != 25 || !reflect.DeepEqual(want, got) {
		t.Fatalf("unified H.264 was altered/re-encoded: input=%d frames output=%d; frame hashes must match", len(want), len(got))
	}
}

func TestUnifiedMP4WithReorderedFramesNormalizesDecodeTimeline(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "reordered.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1", "-c:v", "libx264", "-preset", "veryfast", "-bf", "2", "-g", "25", "-an", input)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate: %v: %s", err, out)
	}
	payload, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var joined []byte
	for i := 0; i < 2; i++ {
		r, err := PayloadToMPEGTS("mp4", payload, float64(i), "")
		if err != nil {
			t.Fatal(err)
		}
		joined = append(joined, r.MPEGTS...)
	}
	output := filepath.Join(dir, "joined.ts")
	if err := os.WriteFile(output, joined, 0600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=has_b_frames", "-of", "csv=p=0", output).Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.Trim(line, " ,\r") != "" && strings.Trim(line, " ,\r") != "0" {
			t.Fatalf("independently timed Telegram fragments retain reordered decode frames: %q", out)
		}
	}
}
