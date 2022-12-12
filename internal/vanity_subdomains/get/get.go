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

	// 2. get vanity subdomain config
	{
		response, err := utils.GetSupabase().GetVanitySubdomainConfigWithResponse(ctx, projectRef)
		if err != nil {
			return err
		}
		if response.JSON200 == nil {
			return fmt.Errorf("failed to obtain vanity subdomain config: %+v", string(response.Body))
		}
		fmt.Printf("Status: %s\n", response.JSON200.Status)
		if response.JSON200.CustomDomain != nil {
			fmt.Printf("Vanity subdomain: %s\n", *response.JSON200.CustomDomain)
		}
		return nil
	}
}
