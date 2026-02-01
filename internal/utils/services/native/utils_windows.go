//go:build windows

package native

import (
	"syscall"
)

func getSysProc(name string) (*syscall.SysProcAttr, error) {
	return nil, nil
}
