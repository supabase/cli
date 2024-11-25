package migration

import (
	"context"
	"database/sql"
	"encoding/csv"

	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/stdlib"
)

func getRemoteSeeds(ctx context.Context, conn *pgx.Conn) (map[string]string, error) {
	remotes, err := ReadSeedTable(ctx, conn)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UndefinedTable {
			// If seed table is undefined, the remote project has no migrations
			return nil, nil
		}
		return nil, err
	}
	applied := make(map[string]string, len(remotes))
	for _, seed := range remotes {
		applied[seed.Path] = seed.Hash
	}
	return applied, nil
}

func GetPendingSeeds(ctx context.Context, locals []string, conn *pgx.Conn, fsys fs.FS) ([]SeedFile, error) {
	if len(locals) == 0 {
		return nil, nil
	}
	applied, err := getRemoteSeeds(ctx, conn)
	if err != nil {
		return nil, err
	}
	var pending []SeedFile
	for _, path := range locals {
		seed, err := NewSeedFile(path, fsys)
		if err != nil {
			return nil, err
		}
		if hash, exists := applied[seed.Path]; exists {
			// Skip seed files that already exist
			if hash == seed.Hash {
				continue
			}
			// Mark seed file as dirty
			seed.Dirty = true
		}
		pending = append(pending, *seed)
	}
	return pending, nil
}
func importWithStream(ctx context.Context, csvStream io.Reader, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("failed to get Db connection fro sql.DB instance: %w", err)
	}

	if err = conn.Raw(func(driverConn any) error {
		pgxConn := driverConn.(*stdlib.Conn).Conn()
		_, err := pgxConn.CopyFrom(ctx, pgx.Identifier{"categories"}, peopleColumns, newPeopleCopyFromSource(csvStream))
		if err != nil {
			return fmt.Errorf("failed to import data into database: %w", err)
		}

		return nil
	}); err != nil {
		return fmt.Errorf("failed to resolve raw conection: %w", err)
	}
	return nil
}

var peopleColumns = []string{
	"id",
	"name",
	"color",
	"created_at",
}

func newPeopleCopyFromSource(csvStream io.Reader) *peopleCopyFromSource {
	csvReader := csv.NewReader(csvStream)
	csvReader.ReuseRecord = true // reuse slice to return the record line by line
	csvReader.FieldsPerRecord = len(peopleColumns)

	return &peopleCopyFromSource{
		reader: csvReader,
		isBOF:  true, // first line is header
		record: make([]interface{}, len(peopleColumns)),
	}
}

type peopleCopyFromSource struct {
	reader        *csv.Reader
	err           error
	currentCsvRow []string
	record        []interface{}
	isEOF         bool
	isBOF         bool
}

func (pfs *peopleCopyFromSource) Values() ([]any, error) {
	if pfs.isEOF {
		return nil, nil
	}

	if pfs.err != nil {
		return nil, pfs.err
	}

	// the order of the elements of the record array, must match with
	// the order of the columns in passed into the copy method
	pfs.record[0] = pfs.currentCsvRow[0]
	pfs.record[1] = pfs.currentCsvRow[1]
	pfs.record[2] = pfs.currentCsvRow[2]
	pfs.record[2] = pfs.currentCsvRow[2]
	return pfs.record, nil
}

func (pfs *peopleCopyFromSource) Next() bool {
	pfs.currentCsvRow, pfs.err = pfs.reader.Read()
	if pfs.err != nil {

		// when get to the end of the file return false and clean the error.
		// If it's io.EOF we can't return an error
		if errors.Is(pfs.err, io.EOF) {
			pfs.isEOF = true
			pfs.err = nil
		}
		return false
	}

	if pfs.isBOF {
		pfs.isBOF = false
		return pfs.Next()
	}

	return true
}

func (pfs *peopleCopyFromSource) Err() error {
	return pfs.err
}

func SeedData(ctx context.Context, pending []SeedFile, conn *pgx.Conn, fsys fs.FS) error {
	f, err := os.Open("/Users/avallete/Programming/Supa/cli/supabase/categories.csv")
	if err != nil {
		return err
	}
	defer f.Close()

	// Create sql.DB from the existing pgx.Conn
	if _, err := conn.PgConn().CopyFrom(ctx, f, `copy "categories" ( "id", "name", "color", "created_at" ) from stdin WITH (FORMAT csv, HEADER true);`); err != nil {
		return fmt.Errorf("failed to copy categories data: %w", err)
	}
	return nil
}

func SeedGlobals(ctx context.Context, pending []string, conn *pgx.Conn, fsys fs.FS) error {
	for _, path := range pending {
		filename := filepath.Base(path)
		fmt.Fprintf(os.Stderr, "Seeding globals from %s...\n", filename)
		globals, err := NewMigrationFromFile(path, fsys)
		if err != nil {
			return err
		}
		// Skip inserting to migration history
		globals.Version = ""
		if err := globals.ExecBatch(ctx, conn); err != nil {
			return err
		}
	}
	return nil
}
