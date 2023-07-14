package disable

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	ref, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().DisableBranchWithResponse(ctx, ref)
	if err != nil {
		return err
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error disabling preview branching: " + string(resp.Body))
	}
	fmt.Println("Disabled preview branching for project:", ref)
	return nil
}
