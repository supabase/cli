package list

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetProjectsWithResponse(ctx)
	if err != nil {
		return errors.Errorf("failed to list projects: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}

	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil && err != utils.ErrNotLinked {
		fmt.Fprintln(os.Stderr, err)
	}

	table := `LINKED|ORG ID|REFERENCE ID|NAME|REGION|CREATED AT (UTC)
|-|-|-|-|-|-|
`
	for _, project := range *resp.JSON200 {
		if t, err := time.Parse(time.RFC3339, project.CreatedAt); err == nil {
			project.CreatedAt = t.UTC().Format("2006-01-02 15:04:05")
		}
		if region, ok := utils.RegionMap[project.Region]; ok {
			project.Region = region
		}
		linked := " "
		if project.Id == projectRef {
			linked = "  ●"
		}
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
			linked,
			project.OrganizationId,
			project.Id,
			strings.ReplaceAll(project.Name, "|", "\\|"),
			project.Region,
			utils.FormatTimestamp(project.CreatedAt),
		)
	}

	return list.RenderTable(table)
}
