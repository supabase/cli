package push

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

var (
	errConflict = errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold(utils.MigrationsDir) + ".")
)

func Run(ctx context.Context, dryRun bool, username, password, database, host string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}
	conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, host, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := getPendingMigrations(ctx, conn, fsys)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		fmt.Println("Linked project is up to date.")
		return nil
	}
	// Push pending migrations
	for _, filename := range pending {
		if dryRun {
			fmt.Fprintln(os.Stderr, "Would push migration "+utils.Bold(filename)+"...")
			continue
		}
		if err := pushMigration(ctx, conn, filename, fsys); err != nil {
			return err
		}
	}
	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}

func getPendingMigrations(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) ([]string, error) {
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

func pushMigration(ctx context.Context, conn *pgx.Conn, filename string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Pushing migration "+utils.Bold(filename)+"...")
	sql, err := fsys.Open(filepath.Join(utils.MigrationsDir, filename))
	if err != nil {
		return err
	}
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return err
	}
	batch := pgconn.Batch{}
	for _, line := range lines {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	// Insert into migration history
	lines = append(lines, repair.INSERT_MIGRATION_VERSION)
	version := utils.MigrateFilePattern.FindStringSubmatch(filename)[1]
	repair.InsertVersionSQL(&batch, version)
	// ExecBatch is implicitly transactional
	if result, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		i := len(result)
		var stat string
		if i < len(lines) {
			stat = lines[i]
		}
		return fmt.Errorf("%v\nAt statement %d: %s", err, i, utils.Aqua(stat))
	}
	return nil
}
