package create

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, name, region string, fsys afero.Fs) error {
	ref, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	gitBranch := keys.GetGitBranchOrDefault("", fsys)
	if len(name) == 0 {
		name = gitBranch
	}

	resp, err := utils.GetSupabase().CreateBranchWithResponse(ctx, ref, api.CreateBranchJSONRequestBody{
		BranchName: name,
		GitBranch:  &gitBranch,
		Region:     &region,
	})
	if err != nil {
		return err
	}

	if resp.JSON201 == nil {
		return errors.New("Unexpected error creating preview branch: " + string(resp.Body))
	}

	fmt.Println("Created preview branch:", resp.JSON201.Id)
	return nil
}
