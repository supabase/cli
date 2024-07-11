package migration

import (
	"context"
	"io"
	"io/fs"
	"path/filepath"
	"regexp"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/parser"
)

type MigrationFile struct {
	Version    string
	Name       string
	Statements []string
}

var migrateFilePattern = regexp.MustCompile(`^([0-9]+)_(.*)\.sql$`)

func NewMigrationFromFile(path string, fsys fs.FS) (*MigrationFile, error) {
	sql, err := fsys.Open(path)
	if err != nil {
		return nil, errors.Errorf("failed to open migration file: %w", err)
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
		matches := migrateFilePattern.FindStringSubmatch(filename)
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
	return &MigrationFile{Statements: lines}, nil
}

func (m *MigrationFile) ExecBatch(ctx context.Context, conn *pgx.Conn) error {
	// Batch migration commands, without using statement cache
	batch := &pgconn.Batch{}
	for _, line := range m.Statements {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	// Insert into migration history
	if len(m.Version) > 0 {
		if err := m.insertVersionSQL(conn, batch); err != nil {
			return err
		}
	}
	// ExecBatch is implicitly transactional
	if result, err := conn.PgConn().ExecBatch(ctx, batch).ReadAll(); err != nil {
		// Defaults to printing the last statement on error
		stat := INSERT_MIGRATION_VERSION
		i := len(result)
		if i < len(m.Statements) {
			stat = m.Statements[i]
		}
		return errors.Errorf("%w\nAt statement %d: %s", err, i, stat)
	}
	return nil
}

func (m *MigrationFile) insertVersionSQL(conn *pgx.Conn, batch *pgconn.Batch) error {
	value := pgtype.TextArray{}
	if err := value.Set(m.Statements); err != nil {
		return errors.Errorf("failed to set text array: %w", err)
	}
	ci := conn.ConnInfo()
	var err error
	var encoded []byte
	var valueFormat int16
	if conn.Config().PreferSimpleProtocol {
		encoded, err = value.EncodeText(ci, encoded)
		valueFormat = pgtype.TextFormatCode
	} else {
		encoded, err = value.EncodeBinary(ci, encoded)
		valueFormat = pgtype.BinaryFormatCode
	}
	if err != nil {
		return errors.Errorf("failed to encode binary: %w", err)
	}
	batch.ExecParams(
		INSERT_MIGRATION_VERSION,
		[][]byte{[]byte(m.Version), []byte(m.Name), encoded},
		[]uint32{pgtype.TextOID, pgtype.TextOID, pgtype.TextArrayOID},
		[]int16{pgtype.TextFormatCode, pgtype.TextFormatCode, valueFormat},
		nil,
	)
	return nil
}

func (m *MigrationFile) ExecBatchWithCache(ctx context.Context, conn *pgx.Conn) error {
	// Data statements don't mutate schemas, safe to use statement cache
	batch := pgx.Batch{}
	for _, line := range m.Statements {
		batch.Queue(line)
	}
	// No need to track version here because there are no schema changes
	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to send batch: %w", err)
	}
	return nil
}
