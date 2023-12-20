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
	// 2. get vanity subdomain config
	{
		response, err := utils.GetSupabase().GetVanitySubdomainConfigWithResponse(ctx, projectRef)
		if err != nil {
			return errors.Errorf("failed to get vanity subdomain: %w", err)
		}
		if response.JSON200 == nil {
			return errors.Errorf("failed to obtain vanity subdomain config: %+v", string(response.Body))
		}
		fmt.Printf("Status: %s\n", response.JSON200.Status)
		if response.JSON200.CustomDomain != nil {
			fmt.Printf("Vanity subdomain: %s\n", *response.JSON200.CustomDomain)
		}
		return nil
	}
}
