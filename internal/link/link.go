package link

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef, username, password, database string, fsys afero.Fs) error {
	// 1. Validate access token + project ref
	if err := validateProjectRef(ctx, projectRef, fsys); err != nil {
		return err
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	// 2. Check database connection
	{
		conn, err := commit.ConnectRemotePostgres(ctx, username, password, database, projectRef)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		// Assert db.major_version is compatible.
		if err := commit.AssertPostgresVersionMatch(conn); err != nil {
			return err
		}
		// If `schema_migrations` doesn't exist on the remote database, create it.
		if _, err := conn.Exec(ctx, commit.CHECK_MIGRATION_EXISTS); err != nil {
			if _, err := conn.Exec(ctx, commit.CREATE_MIGRATION_TABLE); err != nil {
				return err
			}
		}
	}

	// 2. Save project ref
	{
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.ProjectRefPath)); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644); err != nil {
			return err
		}
	}

	return nil
}

func validateProjectRef(ctx context.Context, projectRef string, fsys afero.Fs) error {
	if !utils.ProjectRefPattern.MatchString(projectRef) {
		return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
	}

	resp, err := utils.GetSupabase().GetFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Authorization failed for the access token and project ref pair: " + string(resp.Body))
	}

	return nil
}
