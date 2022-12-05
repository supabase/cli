package push

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

const (
	CLEAR_MIGRATION = "TRUNCATE ONLY supabase_migrations.schema_migrations"
)

var (
	errConflict = errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold(utils.MigrationsDir) + ".")
)

func Run(ctx context.Context, dryRun, versionOnly bool, username, password, database, host string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}
	conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, host, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if versionOnly {
		return pushVersion(ctx, dryRun, conn, fsys)
	}
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

func pushVersion(ctx context.Context, dryRun bool, conn *pgx.Conn, fsys afero.Fs) error {
	localVersions, err := list.LoadLocalVersions(fsys)
	if err != nil {
		return err
	}
	if dryRun {
		fmt.Fprintln(os.Stderr, "Would rewrite migration versions as:")
		return list.RenderTable(localVersions, localVersions)
	}
	// Create history table if not exists
	sql := strings.NewReader(commit.CREATE_MIGRATION_TABLE + CLEAR_MIGRATION)
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return err
	}
	batch := pgconn.Batch{}
	for _, line := range lines {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	// Insert into migration history
	for _, version := range localVersions {
		insertVersionSQL(&batch, version)
	}
	if _, err = conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Pushed migration versions to remote:")
	return list.RenderTable(localVersions, localVersions)
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
	lines = append(lines, commit.INSERT_MIGRATION_VERSION)
	version := utils.MigrateFilePattern.FindStringSubmatch(filename)[1]
	insertVersionSQL(&batch, version)
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

func insertVersionSQL(batch *pgconn.Batch, version string) {
	batch.ExecParams(
		commit.INSERT_MIGRATION_VERSION,
		[][]byte{[]byte(version)},
		[]uint32{pgtype.TextOID},
		[]int16{pgtype.TextFormatCode},
		nil,
	)
}
