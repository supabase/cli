package list

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

type linkedProject struct {
	api.V1ProjectWithDatabaseResponse `yaml:",inline"`
	Linked                            bool `json:"linked"`
}

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ListAllProjectsWithResponse(ctx)
	if err != nil {
		return errors.Errorf("failed to list projects: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}

	if err := flags.LoadProjectRef(fsys); err != nil && err != utils.ErrNotLinked {
		fmt.Fprintln(os.Stderr, err)
	}

	var projects []linkedProject
	for _, project := range *resp.JSON200 {
		projects = append(projects, linkedProject{
			V1ProjectWithDatabaseResponse: project,
			Linked:                        project.Id == flags.ProjectRef,
		})
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := `LINKED|ORG ID|REFERENCE ID|NAME|REGION|CREATED AT (UTC)
|-|-|-|-|-|-|
`
		for _, project := range projects {
			table += fmt.Sprintf(
				"|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
				formatBullet(project.Linked),
				project.OrganizationId,
				project.Id,
				strings.ReplaceAll(project.Name, "|", "\\|"),
				utils.FormatRegion(project.Region),
				utils.FormatTimestamp(project.CreatedAt),
			)
		}
		return list.RenderTable(table)
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Projects []linkedProject `toml:"projects"`
		}{
			Projects: projects,
		})
	case utils.OutputEnv:
		return errors.Errorf("--output env flag is not supported")
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, projects)
}

func formatBullet(value bool) string {
	if value {
		return "  ●"
	}
	return " "
}
