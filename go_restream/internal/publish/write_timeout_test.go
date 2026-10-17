package publish

import (
	"os"
	"testing"
	"time"
)

func TestBlockedCapturePipeWriteIsBounded(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	result := make(chan error, 1)
	go func() { result <- writeAll(writer, make([]byte, 2<<20)) }()
	select {
	case err := <-result:
		if err == nil || !os.IsTimeout(err) {
			t.Fatalf("blocked capture write must return a deadline error, got %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = writer.Close()
		<-result
		t.Fatal("capture pipe write ignored its timeout and blocked shutdown/recovery")
	}
}
