package list

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ListAllBranchesWithResponse(ctx, flags.ProjectRef)
	if err != nil {
		return errors.Errorf("failed to list preview branches: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error listing preview branches: " + string(resp.Body))
	}

	table := `|ID|NAME|DEFAULT|GIT BRANCH|STATUS|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|-|
`
	for _, branch := range *resp.JSON200 {
		gitBranch := " "
		if branch.GitBranch != nil {
			gitBranch = *branch.GitBranch
		}
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%t`|`%s`|`%s`|`%s`|`%s`|\n",
			branch.Id,
			strings.ReplaceAll(branch.Name, "|", "\\|"),
			branch.IsDefault,
			strings.ReplaceAll(gitBranch, "|", "\\|"),
			branch.Status,
			utils.FormatTimestamp(branch.CreatedAt),
			utils.FormatTimestamp(branch.UpdatedAt),
		)
	}

	return list.RenderTable(table)
}
