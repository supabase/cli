package get

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRefArg string, includeRawOutput bool, fsys afero.Fs) error {
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
