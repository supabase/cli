package update

import (
	"context"
	"fmt"
	"net"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func validateIps(ips []string) error {
	for _, ip := range ips {
		ip := net.ParseIP(ip)
		if ip.To4() == nil {
			return errors.Errorf("only IPv4 supported at the moment: %s", ip)
		}
	}
	return nil
}

func Run(ctx context.Context, projectRef string, dbIpsToUnban []string, fsys afero.Fs) error {
	// 1. sanity checks
	{
		err := validateIps(dbIpsToUnban)
		if err != nil {
			return err
		}
	}

	// 2. remove bans
	{
		resp, err := utils.GetSupabase().RemoveNetworkBanWithResponse(ctx, projectRef, api.RemoveNetworkBanRequest{
			Ipv4Addresses: dbIpsToUnban,
		})
		if err != nil {
			return err
		}
		if resp.StatusCode() != 200 {
			return errors.New("failed to remove network bans: " + string(resp.Body))
		}
		fmt.Printf("Successfully removed bans for %+v.\n", dbIpsToUnban)
		return nil
	}
}
