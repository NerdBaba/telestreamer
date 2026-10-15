package restream

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

type child struct {
	cmd    *exec.Cmd
	done   chan struct{}
	exited atomic.Bool
}

func launch(cmd *exec.Cmd) (*child, error) {
	// FFmpeg diagnostics can include provider URLs or signed headers. Keep them
	// out of the public event log and report the stage through the controller.
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("media executable unavailable")
	}
	p := &child{cmd: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); p.exited.Store(true); close(p.done) }()
	return p, nil
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
	m.Stop()
	if s.URL == "" || strings.ContainsAny(s.URL+s.Headers+destination, "\x00") {
		return fmt.Errorf("source media unavailable")
	}
	if !m.Demo && (!strings.HasPrefix(destination, "rtmp://") && !strings.HasPrefix(destination, "rtmps://") || strings.ContainsAny(destination, "\r\n")) {
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
		args = append(args, "-rw_timeout", "15000000", "-fflags", "+genpts+discardcorrupt")
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
	deadline := time.NewTimer(18 * time.Second)
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
	if !m.Demo {
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
