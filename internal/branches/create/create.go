package create

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/branches/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, body api.CreateBranchBody, fsys afero.Fs) error {
	gitBranch := utils.GetGitBranchOrDefault("", fsys)
	if len(body.BranchName) == 0 && len(gitBranch) > 0 {
		title := fmt.Sprintf("Do you want to create a branch named %s?", utils.Aqua(gitBranch))
		if shouldCreate, err := utils.NewConsole().PromptYesNo(ctx, title, true); err != nil {
			return err
		} else if !shouldCreate {
			return errors.New(context.Canceled)
		}
		body.BranchName = gitBranch
		body.GitBranch = &gitBranch
	}

	resp, err := utils.GetSupabase().V1CreateABranchWithResponse(ctx, flags.ProjectRef, body)
	if err != nil {
		return errors.Errorf("failed to create preview branch: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected create branch status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	fmt.Println("Created preview branch:")
	if utils.OutputFormat.Value == utils.OutputPretty {
		table := list.ToMarkdown([]api.BranchResponse{*resp.JSON201})
		return utils.RenderTable(table)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
}
