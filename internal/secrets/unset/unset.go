package unset

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertIsLinkedFS(fsys); err != nil {
			return err
		}
	}

	// 2. Unset secret(s).
	{
		projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

		resp, err := utils.GetSupabase().DeleteSecretsWithResponse(ctx, projectRef, args)
		if err != nil {
			return err
		}

		if resp.StatusCode() != http.StatusOK {
			return errors.New("Unexpected error unsetting project secrets: " + string(resp.Body))
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets unset") + ".")
	return nil
}
