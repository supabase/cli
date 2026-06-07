package update

import (
	"context"
	"net"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils/flags"
)

func validateIps(ips []string) error {
	for _, ip := range ips {
		if net.ParseIP(ip) == nil {
			return errors.Errorf("invalid IP address: %s", ip)
		}
	}
	return nil
}

func Run(ctx context.Context, projectRef string, dbIpsToUnban []string, fsys afero.Fs) error {
	// 1. sanity checks
	if err := validateIps(dbIpsToUnban); err != nil {
		return err
	}
	// 2. remove bans
	return flags.UnbanIP(ctx, projectRef, dbIpsToUnban...)
}
