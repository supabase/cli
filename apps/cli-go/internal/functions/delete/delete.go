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
	if err := utils.ValidateFunctionSlug(slug); err != nil {
		return err
	}
	if err := Undeploy(ctx, projectRef, slug); err != nil {
		return err
	}
	fmt.Printf("Deleted Function %s from project %s.\n", utils.Aqua(slug), utils.Aqua(projectRef))
	return nil
}

var ErrNoDelete = errors.New("nothing to delete")

func Undeploy(ctx context.Context, projectRef string, slug string) error {
	resp, err := utils.GetSupabase().V1DeleteAFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to delete function: %w", err)
	}
	switch resp.StatusCode() {
	case http.StatusNotFound:
		return errors.Errorf("Function %s does not exist on the Supabase project: %w", slug, ErrNoDelete)
	case http.StatusOK:
		return nil
	default:
		return errors.Errorf("unexpected delete function status %d: %s", resp.StatusCode(), string(resp.Body))
	}
}
