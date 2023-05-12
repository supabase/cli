package delete

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
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
