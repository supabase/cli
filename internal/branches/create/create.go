package create

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, name, region string, fsys afero.Fs) error {
	gitBranch := keys.GetGitBranchOrDefault("", fsys)
	if len(name) == 0 && len(gitBranch) > 0 {
		title := fmt.Sprintf("Do you want to create a branch named %s?", utils.Aqua(gitBranch))
		if shouldCreate, err := utils.NewConsole().PromptYesNo(ctx, title, true); err != nil {
			return err
		} else if !shouldCreate {
			return errors.New(context.Canceled)
		}
		name = gitBranch
	}

	resp, err := utils.GetSupabase().V1CreateABranchWithResponse(ctx, flags.ProjectRef, api.V1CreateABranchJSONRequestBody{
		BranchName: name,
		GitBranch:  &gitBranch,
		Region:     &region,
	})
	if err != nil {
		return errors.Errorf("failed to create preview branch: %w", err)
	}

	if resp.JSON201 == nil {
		return errors.New("Unexpected error creating preview branch: " + string(resp.Body))
	}

	fmt.Println("Created preview branch:", resp.JSON201.Id)
	return nil
}
