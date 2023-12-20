package get

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. get network bans
	{
		resp, err := utils.GetSupabase().GetNetworkBansWithResponse(ctx, projectRef)
		if err != nil {
			return errors.Errorf("failed to retrieve network bans: %w", err)
		}
		if resp.JSON201 == nil {
			return errors.New("Unexpected error retrieving network bans: " + string(resp.Body))
		}
		fmt.Printf("DB banned IPs: %+v\n", resp.JSON201.BannedIpv4Addresses)
		return nil
	}
}
