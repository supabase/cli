package update

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/branches/list"
	"github.com/supabase/cli/internal/branches/pause"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, branchId string, body api.UpdateBranchBody, fsys afero.Fs) error {
	projectRef, err := pause.GetBranchProjectRef(ctx, branchId)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().V1UpdateABranchConfigWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to update preview branch: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected update branch status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Fprintln(os.Stderr, "Updated preview branch:")
	if utils.OutputFormat.Value == utils.OutputPretty {
		table := list.ToMarkdown([]api.BranchResponse{*resp.JSON200})
		return utils.RenderTable(table)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}
