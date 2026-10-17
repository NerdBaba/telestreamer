package restream

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type child struct {
	cmd         *exec.Cmd
	done        chan struct{}
	exited      atomic.Bool
	diagnostics senderDiagnostics
}

func launch(cmd *exec.Cmd) (*child, error) {
	// FFmpeg diagnostics can include provider URLs or signed headers. Keep them
	// out of the public event log and report the stage through the controller.
	p := &child{cmd: cmd, done: make(chan struct{})}
	cmd.Stdout = io.Discard
	cmd.Stderr = &p.diagnostics
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("media executable unavailable")
	}
	go func() { _ = cmd.Wait(); p.exited.Store(true); close(p.done) }()
	return p, nil
}

// Only exact, static native-sender messages may reach the dashboard. FFmpeg
// output can contain private URLs, so unknown lines are discarded and bounded.
type senderDiagnostics struct {
	mu       sync.Mutex
	line     []byte
	overflow bool
	reason   string
}

func (d *senderDiagnostics) Write(data []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, b := range data {
		if b == '\n' {
			if !d.overflow {
				switch string(d.line) {
				case "RTMP sender: initialization failed", "RTMP sender: expected local HLS playlist path",
					"RTMP sender: invalid destination pipe", "RTMP sender: cannot open local HLS input",
					"RTMP sender: input requires H.264 video and AAC when audio is present",
					"RTMP sender: cannot configure FLV output", "RTMP sender: cannot connect publishing output",
					"RTMP sender: media read or publishing write failed", "RTMP sender: timestamp discontinuity or publishing lag":
					d.reason = strings.TrimPrefix(string(d.line), "RTMP sender: ")
				}
			}
			d.line = d.line[:0]
			d.overflow = false
		} else if len(d.line) < 256 {
			d.line = append(d.line, b)
		} else {
			d.overflow = true
		}
	}
	return len(data), nil
}
func (p *child) Failure() string {
	p.diagnostics.mu.Lock()
	defer p.diagnostics.mu.Unlock()
	return p.diagnostics.reason
}

func (p *child) stop() {
	if p == nil {
		return
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

type ProcessMedia struct {
	ctx            context.Context
	Dir, Sender    string
	ffmpeg, sender *child
	Demo           bool
}

func NewProcessMedia(ctx context.Context, dir, sender string) *ProcessMedia {
	return &ProcessMedia{ctx: ctx, Dir: dir, Sender: sender}
}
func outputReady(path string, now time.Time) bool {
	st, err := os.Stat(path)
	if err != nil || now.Sub(st.ModTime()) > 20*time.Second {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "#EXTINF:") {
		return false
	}
	refs := playlistRefs(string(data), "file://"+path)
	if len(refs) == 0 {
		return false
	}
	// HLS output always uses plain local filenames, never remote references.
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			if filepath.Base(line) != line {
				return false
			}
			seg, err := os.Stat(filepath.Join(filepath.Dir(path), line))
			return err == nil && seg.Size() > 0
		}
	}
	return false
}
func (m *ProcessMedia) Start(ctx context.Context, s Source, destination string) error {
	return m.start(ctx, s, destination, !m.Demo)
}

// StartPreview remuxes a real input to HLS without publishing a destination.
func (m *ProcessMedia) StartPreview(ctx context.Context, s Source) error {
	return m.start(ctx, s, "", false)
}

func (m *ProcessMedia) start(ctx context.Context, s Source, destination string, send bool) error {
	m.Stop()
	if s.URL == "" || strings.ContainsAny(s.URL+s.Headers+destination, "\x00") {
		return fmt.Errorf("source media unavailable")
	}
	if send && (!strings.HasPrefix(destination, "rtmp://") && !strings.HasPrefix(destination, "rtmps://") || strings.ContainsAny(destination, "\r\n")) {
		return fmt.Errorf("invalid destination")
	}
	if err := os.MkdirAll(m.Dir, 0700); err != nil {
		return fmt.Errorf("cannot create playout directory")
	}
	entries, _ := os.ReadDir(m.Dir)
	for _, e := range entries {
		if !e.IsDir() {
			_ = os.Remove(filepath.Join(m.Dir, e.Name()))
		}
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y"}
	if m.Demo {
		args = append(args, "-re", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "50", "-c:a", "aac")
	} else {
		// HLS can deliver several buffered segments at once. Pace input reads
		// so the local live window cannot delete data ahead of the RTMP sender.
		args = append(args, "-re", "-rw_timeout", "15000000", "-fflags", "+genpts+discardcorrupt")
		if s.Headers != "" {
			args = append(args, "-headers", s.Headers)
		}
		args = append(args, "-i", s.URL, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy")
	}
	playlist := filepath.Join(m.Dir, "index.m3u8")
	// Epoch numbering stops browser caches mistaking a new run for old segments.
	args = append(args, "-f", "hls", "-hls_time", "2", "-hls_list_size", "8", "-hls_delete_threshold", "2", "-hls_start_number_source", "epoch_us", "-hls_flags", "delete_segments+omit_endlist+independent_segments+temp_file", "-hls_segment_filename", filepath.Join(m.Dir, "s%d.ts"), playlist)
	var err error
	m.ffmpeg, err = launch(exec.CommandContext(m.ctx, "ffmpeg", args...))
	if err != nil {
		return err
	}
	wait := time.NewTicker(100 * time.Millisecond)
	defer wait.Stop()
	// Nested HLS discovery can exceed 18s while reads still make progress.
	// Keep startup bounded below the controller's 25s operation deadline.
	deadline := time.NewTimer(22 * time.Second)
	defer deadline.Stop()
	for !outputReady(playlist, time.Now()) {
		select {
		case <-ctx.Done():
			m.Stop()
			return fmt.Errorf("media preparation cancelled")
		case <-deadline.C:
			m.Stop()
			return fmt.Errorf("media did not produce playable segments")
		case <-m.ffmpeg.done:
			m.Stop()
			return fmt.Errorf("media input ended before readiness")
		case <-wait.C:
		}
	}
	if send {
		cmd := exec.CommandContext(m.ctx, m.Sender, playlist)
		cmd.Stdin = strings.NewReader(destination)
		m.sender, err = launch(cmd)
		if err != nil {
			m.Stop()
			return err
		}
	}
	return nil
}
func (m *ProcessMedia) Stop() { m.sender.stop(); m.sender = nil; m.ffmpeg.stop(); m.ffmpeg = nil }
func (m *ProcessMedia) Healthy(now time.Time) bool {
	return m.ffmpeg != nil && !m.ffmpeg.exited.Load() && (m.Demo || m.sender != nil && !m.sender.exited.Load()) && outputReady(filepath.Join(m.Dir, "index.m3u8"), now)
}

// Failure reports a safe stage, never raw media stderr or provider URLs.
func (m *ProcessMedia) Failure() string {
	if m.ffmpeg != nil && m.ffmpeg.exited.Load() {
		return "source media process exited"
	}
	if m.sender != nil && m.sender.exited.Load() {
		if reason := m.sender.Failure(); reason != "" {
			return reason
		}
		return "publishing sender exited"
	}
	return ""
}
