package activate

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, includeRawOutput bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		resp, err := hostnames.GetCustomHostnameConfig(ctx, projectRef)
		if err != nil {
			return err
		}
		err = hostnames.VerifyCNAME(ctx, projectRef, resp.JSON200.CustomHostname)
		if err != nil {
			return err
		}
	}

	// 2. activate custom hostname config
	{
		resp, err := utils.GetSupabase().ActivateWithResponse(ctx, projectRef)
		if err != nil {
			return errors.Errorf("failed to active custom hostname: %w", err)
		}
		if resp.JSON201 == nil {
			return errors.New("failed to activate custom hostname config: " + string(resp.Body))
		}
		status, err := hostnames.TranslateStatus(resp.JSON201, includeRawOutput)
		if err != nil {
			return err
		}
		fmt.Println(status)
		return nil
	}
}
