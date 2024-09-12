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
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ListAllProjectsWithResponse(ctx)
	if err != nil {
		return errors.Errorf("failed to list projects: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}

	projectRef, err := flags.LoadProjectRef(fsys)
	if err != nil && err != utils.ErrNotLinked {
		fmt.Fprintln(os.Stderr, err)
	}

	if utils.OutputFormat.Value == utils.OutputPretty {
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

	var projects []Project
	for _, project := range *resp.JSON200 {
		projects = append(projects, Project{
			V1ProjectResponse: project,
			Linked:            project.Id == projectRef,
		})
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, projects)
}

type Project struct {
	api.V1ProjectResponse
	Linked bool `json:"linked"`
}
