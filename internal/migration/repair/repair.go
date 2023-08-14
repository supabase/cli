package repair

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

const (
	Applied  = "applied"
	Reverted = "reverted"
)

const (
	CREATE_VERSION_SCHEMA    = "CREATE SCHEMA IF NOT EXISTS supabase_migrations"
	CREATE_VERSION_TABLE     = "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)"
	ADD_STATEMENTS_COLUMN    = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]"
	ADD_NAME_COLUMN          = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text"
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)"
	DELETE_MIGRATION_VERSION = "DELETE FROM supabase_migrations.schema_migrations WHERE version = $1"
)

var ErrInvalidVersion = errors.New("invalid version number")

func Run(ctx context.Context, config pgconn.Config, version, status string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if _, err := strconv.Atoi(version); err != nil {
		return ErrInvalidVersion
	}
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Update migration history
	if err := UpdateMigrationTable(ctx, conn, version, status, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Repaired migration history:", version, "=>", status)
	return nil
}

func UpdateMigrationTable(ctx context.Context, conn *pgx.Conn, version, status string, fsys afero.Fs) error {
	batch := batchCreateTable()
	switch status {
	case Applied:
		f, err := NewMigrationFromVersion(version, fsys)
		if err != nil {
			return err
		}
		InsertVersionSQL(&batch, f.Version, f.Name, f.Lines)
	case Reverted:
		DeleteVersionSQL(&batch, version)
	}
	_, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll()
	return err
}

func batchCreateTable() pgconn.Batch {
	// Create history table if not exists
	batch := pgconn.Batch{}
	batch.ExecParams(CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_TABLE, nil, nil, nil, nil)
	batch.ExecParams(ADD_STATEMENTS_COLUMN, nil, nil, nil, nil)
	batch.ExecParams(ADD_NAME_COLUMN, nil, nil, nil, nil)
	return batch
}

func CreateMigrationTable(ctx context.Context, conn *pgx.Conn) error {
	batch := batchCreateTable()
	_, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll()
	return err
}

func InsertVersionSQL(batch *pgconn.Batch, version, name string, stats []string) {
	encoded := []byte{'{'}
	for i, line := range stats {
		if i > 0 {
			encoded = append(encoded, ',')
		}
		encoded = append(encoded, pgtype.QuoteArrayElementIfNeeded(line)...)
	}
	encoded = append(encoded, '}')
	batch.ExecParams(
		INSERT_MIGRATION_VERSION,
		[][]byte{[]byte(version), []byte(name), encoded},
		[]uint32{pgtype.TextOID, pgtype.TextOID, pgtype.TextArrayOID},
		[]int16{pgtype.TextFormatCode, pgtype.TextFormatCode, pgtype.TextFormatCode},
		nil,
	)
}

func DeleteVersionSQL(batch *pgconn.Batch, version string) {
	batch.ExecParams(
		DELETE_MIGRATION_VERSION,
		[][]byte{[]byte(version)},
		[]uint32{pgtype.TextOID},
		[]int16{pgtype.TextFormatCode},
		nil,
	)
}

func GetMigrationFile(version string, fsys afero.Fs) (string, error) {
	path := filepath.Join(utils.MigrationsDir, version+"_*.sql")
	matches, err := afero.Glob(fsys, path)
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("glob %s: %w", path, os.ErrNotExist)
	}
	return matches[0], nil
}

type MigrationFile struct {
	Lines   []string
	Version string
	Name    string
}

func NewMigrationFromVersion(version string, fsys afero.Fs) (*MigrationFile, error) {
	name, err := GetMigrationFile(version, fsys)
	if err != nil {
		return nil, err
	}
	return NewMigrationFromFile(name, fsys)
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
			if size := int(fi.Size()); size > parser.MaxScannerCapacity {
				parser.MaxScannerCapacity = size
			}
		}
	}
	file, err := NewMigrationFromReader(sql)
	if err == nil {
		// Parse version from file name
		filename := filepath.Base(path)
		matches := utils.MigrateFilePattern.FindStringSubmatch(filename)
		if len(matches) > 2 {
			file.Version = matches[1]
			file.Name = matches[2]
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
	if len(m.Version) > 0 {
		InsertVersionSQL(batch, m.Version, m.Name, m.Lines)
	}
	// ExecBatch is implicitly transactional
	if result, err := conn.PgConn().ExecBatch(ctx, batch).ReadAll(); err != nil {
		// Defaults to printing the last statement on error
		stat := INSERT_MIGRATION_VERSION
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
