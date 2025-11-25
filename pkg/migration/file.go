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

// -----------------------------------------------------------------------------
// ExecBatch (fixed to handle pgx v5 return values correctly)
// -----------------------------------------------------------------------------

func (m *MigrationFile) ExecBatch(ctx context.Context, conn *pgx.Conn) error {
	inTx := false

	for i, stmt := range m.Statements {
		if isNonTransactional(stmt) {

			if inTx {
				if _, err := conn.Exec(ctx, "COMMIT"); err != nil {
					_, _ = conn.Exec(ctx, "ROLLBACK")
					return errors.Errorf("failed to commit transaction before non-transactional statement: %v", err)
				}
				inTx = false
			}

			if _, err := conn.Exec(ctx, stmt); err != nil {
				return formatStatementError(i, stmt, err)
			}

		} else {

			if !inTx {
				if _, err := conn.Exec(ctx, "BEGIN"); err != nil {
					return errors.Errorf("failed to begin transaction: %v", err)
				}
				inTx = true
			}

			if _, err := conn.Exec(ctx, stmt); err != nil {
				if inTx {
					_, _ = conn.Exec(ctx, "ROLLBACK")
					inTx = false
				}
				return formatStatementError(i, stmt, err)
			}
		}
	}

	if inTx {
		if _, err := conn.Exec(ctx, "COMMIT"); err != nil {
			_, _ = conn.Exec(ctx, "ROLLBACK")
			return errors.Errorf("failed to commit transaction: %v", err)
		}
	}

	if len(m.Version) > 0 {
		if err := m.insertVersionExec(ctx, conn); err != nil {
			return err
		}
	}

	return nil
}

// -----------------------------------------------------------------------------
// Error formatter identical to Supabase CLI behavior
// -----------------------------------------------------------------------------

func formatStatementError(idx int, stmt string, err error) error {
	var msg []string
	var pgErr *pgconn.PgError

	if errors.As(err, &pgErr) {
		stat := markError(stmt, int(pgErr.Position))
		if len(pgErr.Detail) > 0 {
			msg = append(msg, pgErr.Detail)
		}
		msg = append(msg, fmt.Sprintf("At statement: %d", idx), stat)
		return errors.Errorf("%w\n%s", err, strings.Join(msg, "\n"))
	}

	return err
}

func markError(stat string, pos int) string {
	lines := strings.Split(stat, "\n")
	for j, r := range lines {
		if c := len(r); pos > c {
			pos -= c + 1
			continue
		}
		if pos > 0 {
			caret := append(bytes.Repeat([]byte{' '}, pos-1), '^')
			lines = append(lines[:j+1], string(caret))
		}
		break
	}
	return strings.Join(lines, "\n")
}

// -----------------------------------------------------------------------------
// insertVersionExec — FULLY FIXED FOR PGX V5 ExecParams
// -----------------------------------------------------------------------------

func (m *MigrationFile) insertVersionExec(ctx context.Context, conn *pgx.Conn) error {
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

	// pgconn.ExecParams RETURNS ONLY ONE VALUE (MultiResultReader)
	res := conn.PgConn().ExecParams(ctx,
		INSERT_MIGRATION_VERSION,
		[][]byte{[]byte(m.Version), []byte(m.Name), encoded},
		[]uint32{pgtype.TextOID, pgtype.TextOID, pgtype.TextArrayOID},
		[]int16{pgtype.TextFormatCode, pgtype.TextFormatCode, valueFormat},
		nil,
	)

	if res.Err() != nil {
		return errors.Errorf("failed to insert migration version: %w", res.Err())
	}

	return nil
}

// -----------------------------------------------------------------------------
// Non-transactional detection
// -----------------------------------------------------------------------------

func isNonTransactional(stmt string) bool {
	upper := strings.ToUpper(stmt)

	if strings.Contains(upper, "CONCURRENTLY") {
		return true
	}

	if regexp.MustCompile(`(?i)ALTER\s+TYPE\s+.+\s+ADD\s+VALUE`).MatchString(stmt) {
		return true
	}

	return false
}

// -----------------------------------------------------------------------------
// Seed File
// -----------------------------------------------------------------------------

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
	lines, err := parseFile(m.Path, fsys)
	if err != nil {
		return err
	}

	batch := pgx.Batch{}
	if !m.Dirty {
		for _, line := range lines {
			batch.Queue(line)
		}
	}

	batch.Queue(UPSERT_SEED_FILE, m.Path, m.Hash)

	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to send batch: %w", err)
	}

	return nil
}
