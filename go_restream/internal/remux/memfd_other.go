//go:build !linux

package remux

import "fmt"

func newMemfdFile(data []byte, suffix string) (*seekableFile, error) {
	return nil, fmt.Errorf("memfd requires Linux")
}
