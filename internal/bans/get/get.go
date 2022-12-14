package get

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRefArg string, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
	}

	// 2. get network bans
	{
		resp, err := utils.GetSupabase().GetNetworkBansWithResponse(ctx, projectRef)
		if err != nil {
			return fmt.Errorf("failed to retrieve network bans: %w", err)
		}
		if resp.JSON201 == nil {
			return errors.New("failed to retrieve network bans; received: " + string(resp.Body))
		}

		if err != nil {
			return err
		}
		fmt.Printf("DB banned IPs: %+v\n", resp.JSON201.BannedIpv4Addresses)
		return nil
	}
}
