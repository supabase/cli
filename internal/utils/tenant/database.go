package tenant

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

var errDatabaseVersion = errors.New("Database version not found.")

func GetDatabaseVersion(ctx context.Context, projectRef string) (string, error) {
	resp, err := utils.GetSupabase().GetProjectsWithResponse(ctx)
	if err != nil {
		return "", errors.Errorf("failed to retrieve projects: %w", err)
	}
	if resp.JSON200 == nil {
		return "", errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}
	for _, project := range *resp.JSON200 {
		if project.Id == projectRef && len(project.Database.Version) > 0 {
			return project.Database.Version, nil
		}
	}
	return "", errors.New(errDatabaseVersion)
}
