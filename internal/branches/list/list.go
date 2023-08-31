package list

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	ref, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().GetBranchesWithResponse(ctx, ref)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error listing preview branches: " + string(resp.Body))
	}

	table := `|ID|NAME|DEFAULT|GIT BRANCH|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|
`
	for _, branch := range *resp.JSON200 {
		gitBranch := " "
		if branch.GitBranch != nil {
			gitBranch = *branch.GitBranch
		}
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%t`|`%s`|`%s`|`%s`|\n",
			branch.Id,
			strings.ReplaceAll(branch.Name, "|", "\\|"),
			branch.IsDefault,
			strings.ReplaceAll(gitBranch, "|", "\\|"),
			utils.FormatTimestamp(branch.CreatedAt),
			utils.FormatTimestamp(branch.UpdatedAt),
		)
	}

	return list.RenderTable(table)
}
