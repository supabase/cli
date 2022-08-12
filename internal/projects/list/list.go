package list

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetProjectsWithResponse(ctx)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}

	table := `|ORG ID|ID|NAME|REGION|CREATED AT (UTC)|
|-|-|-|-|-|
`
	for _, project := range *resp.JSON200 {
		if t, err := time.Parse(time.RFC3339, project.CreatedAt); err == nil {
			project.CreatedAt = t.UTC().Format("2006-01-02 15:04:05")
		}
		if region, ok := utils.RegionMap[project.Region]; ok {
			project.Region = region
		}
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
			project.OrganizationId,
			project.Id,
			strings.ReplaceAll(project.Name, "|", "\\|"),
			project.Region,
			project.CreatedAt,
		)
	}

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}
	out, err := r.Render(table)
	if err != nil {
		return err
	}
	fmt.Print(out)

	return nil
}
