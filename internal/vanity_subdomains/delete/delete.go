package delete

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

	// 2. delete config
	{
		resp, err := utils.GetSupabase().RemoveVanitySubdomainConfigWithResponse(ctx, projectRef)
		if err != nil {
			return err
		}
		if resp.StatusCode() != 200 {
			return errors.New("failed to delete vanity subdomain config; received: " + string(resp.Body))
		}
		fmt.Println("Deleted vanity subdomain successfully.")
		return nil
	}
}
