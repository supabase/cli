package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"

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
	lines, err := parseFile(path, fsys)
	if err != nil {
		return nil, err
	}
	file := MigrationFile{Statements: lines}
	// Parse version from file name
	filename := filepath.Base(path)
	matches := migrateFilePattern.FindStringSubmatch(filename)
	if len(matches) > 2 {
		file.Version = matches[1]
		file.Name = matches[2]
	}
	return &file, nil
}

func parseFile(path string, fsys fs.FS) ([]string, error) {
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
	return parser.SplitAndTrim(sql)
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
		var msg []string
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			stat = markError(stat, int(pgErr.Position))
			if len(pgErr.Detail) > 0 {
				msg = append(msg, pgErr.Detail)
			}
		}
		msg = append(msg, fmt.Sprintf("At statement: %d", i), stat)
		return errors.Errorf("%w\n%s", err, strings.Join(msg, "\n"))
	}
	return nil
}

func markError(stat string, pos int) string {
	lines := strings.Split(stat, "\n")
	for j, r := range lines {
		if c := len(r); pos > c {
			pos -= c + 1
			continue
		}
		// Show a caret below the error position
		if pos > 0 {
			caret := append(bytes.Repeat([]byte{' '}, pos-1), '^')
			lines = append(lines[:j+1], string(caret))
		}
		break
	}
	return strings.Join(lines, "\n")
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

type SeedFile struct {
	Path  string
	Hash  string
	Dirty bool `db:"-"`
}

func NewSeedFile(path string, fsys fs.FS) (*SeedFile, error) {
	sql, err := fsys.Open(path)
	if err != nil {
		return nil, errors.Errorf("failed to open seed file: %w", err)
	}
	defer sql.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, sql); err != nil {
		return nil, errors.Errorf("failed to hash file: %w", err)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	return &SeedFile{Path: path, Hash: digest}, nil
}

func (m *SeedFile) ExecBatchWithCache(ctx context.Context, conn *pgx.Conn, fsys fs.FS) error {
	// Parse each file individually to reduce memory usage
	lines, err := parseFile(m.Path, fsys)
	if err != nil {
		return err
	}
	// Data statements don't mutate schemas, safe to use statement cache
	batch := pgx.Batch{}
	if !m.Dirty {
		for _, line := range lines {
			batch.Queue(line)
		}
	}
	batch.Queue(UPSERT_SEED_FILE, m.Path, m.Hash)
	// No need to track version here because there are no schema changes
	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to send batch: %w", err)
	}
	return nil
}
