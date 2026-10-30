//go:build windows

package workspace

import "errors"

func mkfifo(string) error { return errors.New("no FIFO on Windows") }
