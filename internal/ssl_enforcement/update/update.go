package update

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, enforceDbSsl bool, fsys afero.Fs) error {
	// 1. sanity checks
	// 2. update restrictions
	{
		resp, err := utils.GetSupabase().UpdateSslEnforcementConfigWithResponse(ctx, projectRef, api.UpdateSslEnforcementConfigJSONRequestBody{
			RequestedConfig: api.SslEnforcements{
				Database: enforceDbSsl,
			},
		})
		if err != nil {
			return errors.Errorf("failed to update ssl enforcement: %w", err)
		}
		if resp.JSON200 == nil {
			return errors.New("failed to update SSL enforcement confnig: " + string(resp.Body))
		}
		if resp.JSON200.CurrentConfig.Database && resp.JSON200.AppliedSuccessfully {
			fmt.Println("SSL is now being enforced.")
		} else {
			fmt.Println("SSL is *NOT* being enforced.")
		}
		return nil
	}
}
