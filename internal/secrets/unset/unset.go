package unset

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. Unset secret(s).
	{
		resp, err := utils.GetSupabase().DeleteSecretsWithResponse(ctx, projectRef, args)
		if err != nil {
			return errors.Errorf("failed to delete secrets: %w", err)
		}

		if resp.StatusCode() != http.StatusOK {
			return errors.New("Unexpected error unsetting project secrets: " + string(resp.Body))
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets unset") + ".")
	return nil
}
