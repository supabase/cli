package list

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) (*[]Project, error) {
	resp, err := utils.GetSupabase().V1ListAllProjectsWithResponse(ctx)
	if err != nil {
		return nil, errors.Errorf("failed to list projects: %w", err)
	}

	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}

	projectRef, err := flags.LoadProjectRef(fsys)
	if err != nil && err != utils.ErrNotLinked {
		fmt.Fprintln(os.Stderr, err)
	}

	projects := make([]Project, 0)
	for _, project := range *resp.JSON200 {
		if t, err := time.Parse(time.RFC3339, project.CreatedAt); err == nil {
			project.CreatedAt = t.UTC().Format("2006-01-02 15:04:05")
		}
		if region, ok := utils.RegionMap[project.Region]; ok {
			project.Region = region
		}
		projects = append(projects, Project{
			V1ProjectResponse: project,
			Linked:            project.Id == projectRef,
			Url:               fmt.Sprintf("%s/project/%s", utils.GetSupabaseDashboardURL(), project.Id),
		})

	}

	return &projects, nil
}

type Project struct {
	api.V1ProjectResponse
	Linked bool   `json:"linked"`
	Url    string `json:"url"`
}
