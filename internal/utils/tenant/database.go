package tenant

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

var errDatabaseVersion = errors.New("Database version not found.")

func GetDatabaseVersion(ctx context.Context, projectRef string) (string, error) {
	resp, err := utils.GetSupabase().V1GetProjectWithResponse(ctx, projectRef)
	if err != nil {
		return "", errors.Errorf("failed to retrieve project: %w", err)
	}
	if resp.JSON200 == nil {
		return "", errors.Errorf("unexpected retrieve project status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if len(resp.JSON200.Database.Version) > 0 {
		return resp.JSON200.Database.Version, nil
	}
	return "", errors.New(errDatabaseVersion)
}
