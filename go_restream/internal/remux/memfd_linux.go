//go:build linux

package remux

import (
	"golang.org/x/sys/unix"
	"strings"
)

func newMemfdFile(data []byte, suffix string) (*seekableFile, error) {
	name := "tgtv" + strings.TrimPrefix(suffix, ".")
	fd, err := unix.MemfdCreate(name, 0)
	if err != nil {
		return nil, err
	}
	if _, err := unix.Write(fd, data); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if _, err := unix.Seek(fd, 0, unix.SEEK_SET); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &seekableFile{
		path: procFDPath(fd),
		fd:   fd,
	}, nil
}
