package delete

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, slug string, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Delete Function.
	resp, err := utils.GetSupabase().DeleteFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to delete function: %w", err)
	}
	switch resp.StatusCode() {
	case http.StatusNotFound:
		return errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
	case http.StatusOK:
		break
	default:
		return errors.New("Failed to delete Function " + utils.Aqua(slug) + " on the Supabase project: " + string(resp.Body))
	}

	fmt.Println("Deleted Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}
