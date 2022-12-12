package link

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"golang.org/x/term"
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
		conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, utils.GetSupabaseDbHost(projectRef))
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		// Assert db.major_version is compatible.
		if err := commit.AssertPostgresVersionMatch(conn); err != nil {
			return err
		}
		// If `schema_migrations` doesn't exist on the remote database, create it.
		if _, err := conn.Exec(ctx, repair.CREATE_MIGRATION_TABLE); err != nil {
			return err
		}
		// Save database password
		if err := credentials.Set(projectRef, password); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
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

func PromptPassword(stdin *os.File) string {
	fmt.Print("Enter your database password: ")
	bytepw, err := term.ReadPassword(int(stdin.Fd()))
	fmt.Println()
	if err != nil {
		return ""
	}
	return string(bytepw)
}
