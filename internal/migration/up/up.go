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

func Run(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := GetPendingMigrations(ctx, conn, fsys)
	if err != nil {
		return err
	}
	return apply.MigrateUp(ctx, conn, pending, fsys)
}

func GetPendingMigrations(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) ([]string, error) {
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
