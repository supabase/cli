package up

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

var errConflict = errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold(utils.MigrationsDir) + ".")

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
	// Check remote is in-sync or behind local
	if len(remoteMigrations) > len(localMigrations) {
		return nil, fmt.Errorf("%w; Found %d versions and %d migrations.", errConflict, len(remoteMigrations), len(localMigrations))
	}

	if ignoreVersionMismatch {
		// If ignoreVersionMismatch is true, we need to find the difference between the two arrays
		for _, num2 := range remoteMigrations {
			// Iterate through the first array and remove matching elements
			for i := 0; i < len(localMigrations); i++ {
				if utils.MigrateFilePattern.FindStringSubmatch(localMigrations[i])[1] == num2 {
					// Remove the element from the first array using append
					localMigrations = append(localMigrations[:i], localMigrations[i+1:]...)
					// Decrement the loop counter to avoid skipping elements
					i--
				}
			}
		}

		// Return the difference
		return localMigrations, nil
	}

	for i, remote := range remoteMigrations {
		filename := localMigrations[i]
		// LoadLocalMigrations guarantees we always have a match
		local := utils.MigrateFilePattern.FindStringSubmatch(filename)[1]
		if remote != local {
			return nil, fmt.Errorf("%w; Expected version %s but found migration %s at index %d.", errConflict, remote, filename, i)
		}
	}

	return localMigrations[len(remoteMigrations):], nil
}
