package get

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. get network restrictions
	{
		resp, err := utils.GetSupabase().GetNetworkRestrictionsWithResponse(ctx, projectRef)
		if err != nil {
			return fmt.Errorf("failed to retrieve network restrictions: %w", err)
		}
		if resp.JSON200 == nil {
			return errors.New("failed to retrieve network restrictions; received: " + string(resp.Body))
		}

		if err != nil {
			return err
		}
		fmt.Printf("DB Allowed CIDRs: %+v\n", resp.JSON200.Config.DbAllowedCidrs)
		fmt.Printf("Restrictions applied successfully: %+v\n", resp.JSON200.Status == "applied")
		return nil
	}
}
