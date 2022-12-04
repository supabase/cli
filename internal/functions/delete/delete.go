package delete

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, slug string, projectRefArg string, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRefArg) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Delete Function.
	{
		resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
		if err != nil {
			return err
		}

		switch resp.StatusCode() {
		case http.StatusNotFound: // Function doesn't exist
			return errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
		case http.StatusOK: // Function exists
			resp, err := utils.GetSupabase().DeleteFunctionWithResponse(ctx, projectRef, slug)
			if err != nil {
				return err
			}
			if resp.StatusCode() != http.StatusOK {
				return errors.New("Failed to delete Function " + utils.Aqua(slug) + " on the Supabase project: " + string(resp.Body))
			}
		default:
			return errors.New("Unexpected error deleting Function: " + string(resp.Body))
		}
	}

	fmt.Println("Deleted Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}
