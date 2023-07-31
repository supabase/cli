package up

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

var (
	errMissingRemote = errors.New("Local migration files not found on supabase_migrations.schema_migrations table.")
	errMissingLocal  = errors.New("Remote migration versions not found in " + utils.MigrationsDir + " directory.")
)

func Run(ctx context.Context, ignoreVersionMismatch bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := GetPendingMigrations(ctx, ignoreVersionMismatch, conn, fsys)
	if err != nil {
		return err
	}
	return apply.MigrateUp(ctx, conn, pending, fsys)
}

func GetPendingMigrations(ctx context.Context, ignoreVersionMismatch bool, conn *pgx.Conn, fsys afero.Fs) ([]string, error) {
	remoteMigrations, err := list.LoadRemoteMigrations(ctx, conn)
	if err != nil {
		return nil, err
	}
	localMigrations, err := list.LoadLocalMigrations(fsys)
	if err != nil {
		return nil, err
	}
	// Find unapplied local migrations
	var unapplied []string
	for i, remote := range remoteMigrations {
		for _, filename := range localMigrations[i+len(unapplied):] {
			// Check if migration has been applied before, LoadLocalMigrations guarantees a match
			local := utils.MigrateFilePattern.FindStringSubmatch(filename)[1]
			if remote == local {
				break
			}
			// Include out-of-order local migrations
			unapplied = append(unapplied, filename)
		}
		// Check if all remote versions exist in local
		if i+len(unapplied) >= len(localMigrations) {
			utils.CmdSuggestion = suggestRevertHistory(remoteMigrations[i:])
			return nil, errMissingLocal
		}
	}
	// Enforce linear history by default
	if !ignoreVersionMismatch && len(unapplied) > 0 {
		utils.CmdSuggestion = suggestIgnoreFlag(unapplied)
		return nil, errMissingRemote
	}
	pending := localMigrations[len(remoteMigrations)+len(unapplied):]
	return append(unapplied, pending...), nil
}

func suggestRevertHistory(versions []string) string {
	result := fmt.Sprintln("\nTry repairing the migration history table:")
	for _, ver := range versions {
		result += fmt.Sprintln(utils.Bold("supabase migration repair --status reverted " + ver))
	}
	result += fmt.Sprintln("\nAnd update local migrations to match remote database:")
	result += fmt.Sprintln(utils.Bold("supabase db remote commit"))
	return result
}

func suggestIgnoreFlag(filenames []string) string {
	result := "\nRerun the command with --ignore-version-mismatch flag to apply these migrations:\n"
	for _, name := range filenames {
		result += fmt.Sprintln(utils.Bold(filepath.Join(utils.MigrationsDir, name)))
	}
	return result
}
