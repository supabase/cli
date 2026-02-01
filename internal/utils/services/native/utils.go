//go:build !windows

package native

import (
	"os/user"
	"strconv"
	"syscall"

	"github.com/go-errors/errors"
)

func getSysProc(name string) (*syscall.SysProcAttr, error) {
	// Look up the user details
	pgUser, err := user.Lookup(name)
	if err != nil {
		return nil, errors.Errorf("failed to lookup user: %w", err)
	}
	uid, err := strconv.Atoi(pgUser.Uid)
	if err != nil {
		return nil, errors.Errorf("failed to get uid: %w", err)
	}
	gid, err := strconv.Atoi(pgUser.Gid)
	if err != nil {
		return nil, errors.Errorf("failed to get gid: %w", err)
	}
	return &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid: uint32(uid),
			Gid: uint32(gid),
		},
	}, nil
}
