package get

import (
	"context"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
)

func Run(ctx context.Context, projectRef string, includeRawOutput bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. activate custom hostname config
	{
		resp, err := hostnames.GetCustomHostnameConfig(ctx, projectRef)
		if err != nil {
			return err
		}
		status, err := hostnames.TranslateStatus(resp.JSON200, includeRawOutput)
		if err != nil {
			return err
		}
		fmt.Println(status)
		return nil
	}
}
