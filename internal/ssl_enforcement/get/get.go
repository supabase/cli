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
	// 2. get ssl enforcement config
	{
		resp, err := utils.GetSupabase().GetSslEnforcementConfigWithResponse(ctx, projectRef)
		if err != nil {
			return errors.Errorf("failed to retrieve SSL enforcement config: %w", err)
		}
		if resp.JSON200 == nil {
			return errors.New("failed to retrieve SSL enforcement config; received: " + string(resp.Body))
		}

		if resp.JSON200.CurrentConfig.Database && resp.JSON200.AppliedSuccessfully {
			fmt.Println("SSL is being enforced.")
		} else {
			fmt.Println("SSL is *NOT* being enforced.")
		}
		return nil
	}
}
