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
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	branches, err := ListBranch(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}

	table := `|ID|NAME|DEFAULT|GIT BRANCH|STATUS|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|-|
`
	for _, branch := range branches {
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

type BranchFilter func(api.BranchResponse) bool

func ListBranch(ctx context.Context, ref string, filter ...BranchFilter) ([]api.BranchResponse, error) {
	resp, err := utils.GetSupabase().V1ListAllBranchesWithResponse(ctx, ref)
	if err != nil {
		return nil, errors.Errorf("failed to list branch: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected list branch status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	var result []api.BranchResponse
OUTER:
	for _, branch := range *resp.JSON200 {
		for _, keep := range filter {
			if !keep(branch) {
				continue OUTER
			}
		}
		result = append(result, branch)
	}
	return result, nil
}

func FilterByName(branchName string) BranchFilter {
	return func(br api.BranchResponse) bool {
		return br.Name == branchName
	}
}
