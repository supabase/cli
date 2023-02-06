package update

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRefArg string, enforceDbSsl bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg

	// 1. sanity checks
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

	// 2. update restrictions
	{
		resp, err := utils.GetSupabase().UpdateSslEnforcementConfigWithResponse(ctx, projectRef, api.UpdateSslEnforcementConfigJSONRequestBody{
			RequestedConfig: api.SslEnforcements{
				Database: enforceDbSsl,
			},
		})
		if err != nil {
			return err
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
