package list

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	branches, err := ListBranch(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := ToMarkdown(branches)
		return utils.RenderTable(table)
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Branches []api.BranchResponse `toml:"branches"`
		}{
			Branches: branches,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, branches)
}

func ToMarkdown(branches []api.BranchResponse) string {
	var table strings.Builder
	table.WriteString(`|ID|NAME|DEFAULT|GIT BRANCH|WITH DATA|STATUS|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|-|-|
`)
	for _, branch := range branches {
		gitBranch := " "
		if branch.GitBranch != nil {
			gitBranch = *branch.GitBranch
		}
		fmt.Fprintf(&table, "|`%s`|`%s`|`%t`|`%s`|`%t`|`%s`|`%s`|`%s`|\n",
			branch.ProjectRef,
			strings.ReplaceAll(branch.Name, "|", "\\|"),
			branch.IsDefault,
			strings.ReplaceAll(gitBranch, "|", "\\|"),
			branch.WithData,
			branch.Status,
			utils.FormatTime(branch.CreatedAt),
			utils.FormatTime(branch.UpdatedAt))
	}
	return table.String()
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
