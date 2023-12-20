package disable

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	ref, err := flags.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().DisableBranchWithResponse(ctx, ref)
	if err != nil {
		return errors.Errorf("failed to disable preview branching: %w", err)
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error disabling preview branching: " + string(resp.Body))
	}
	fmt.Println("Disabled preview branching for project:", ref)
	return nil
}
