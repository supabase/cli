package apply

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

func MigrateDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	migrations, err := list.LoadLocalMigrations(fsys)
	if err != nil {
		return err
	}
	// Apply migrations
	for _, filename := range migrations {
		if err := migrateUp(ctx, conn, filename, fsys); err != nil {
			return err
		}
	}
	return nil
}

func migrateUp(ctx context.Context, conn *pgx.Conn, filename string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Applying migration "+utils.Bold(filename)+"...")
	path := filepath.Join(utils.MigrationsDir, filename)
	migration, err := NewMigrationFromFile(path, fsys)
	if err != nil {
		return err
	}
	// Skip inserting to migration history table
	migration.version = ""
	return migration.ExecBatch(ctx, conn)
}

func BatchExecDDL(ctx context.Context, conn *pgx.Conn, sql io.Reader) error {
	migration, err := NewMigrationFromReader(sql)
	if err != nil {
		return err
	}
	return migration.ExecBatch(ctx, conn)
}

type MigrationFile struct {
	Lines   []string
	version string
}

func NewMigrationFromFile(path string, fsys afero.Fs) (*MigrationFile, error) {
	sql, err := fsys.Open(path)
	if err != nil {
		return nil, err
	}
	defer sql.Close()
	// Unless explicitly specified, Use file length as max buffer size
	if !viper.IsSet("SCANNER_BUFFER_SIZE") {
		if fi, err := sql.Stat(); err == nil {
			viper.Set("SCANNER_BUFFER_SIZE", strconv.FormatInt(fi.Size(), 10))
		}
	}
	file, err := NewMigrationFromReader(sql)
	if err == nil {
		// Parse version from file name
		filename := filepath.Base(path)
		matches := utils.MigrateFilePattern.FindStringSubmatch(filename)
		if len(matches) > 1 {
			file.version = matches[1]
		}
	}
	return file, err
}

func NewMigrationFromReader(sql io.Reader) (*MigrationFile, error) {
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return nil, err
	}
	return &MigrationFile{Lines: lines}, nil
}

func (m *MigrationFile) ExecBatch(ctx context.Context, conn *pgx.Conn) error {
	// Batch migration commands, without using statement cache
	batch := &pgconn.Batch{}
	for _, line := range m.Lines {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	// Insert into migration history
	if len(m.version) > 0 {
		repair.InsertVersionSQL(batch, m.version)
	}
	// ExecBatch is implicitly transactional
	if result, err := conn.PgConn().ExecBatch(ctx, batch).ReadAll(); err != nil {
		// Defaults to printing the last statement on error
		stat := repair.INSERT_MIGRATION_VERSION
		i := len(result)
		if i < len(m.Lines) {
			stat = m.Lines[i]
		}
		return fmt.Errorf("%w\nAt statement %d: %s", err, i, utils.Aqua(stat))
	}
	return nil
}

func (m *MigrationFile) ExecBatchWithCache(ctx context.Context, conn *pgx.Conn) error {
	// Data statements don't mutate schemas, safe to use statement cache
	batch := pgx.Batch{}
	for _, line := range m.Lines {
		batch.Queue(line)
	}
	// No need to track version here because there are no schema changes
	return conn.SendBatch(ctx, &batch).Close()
}
