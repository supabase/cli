package migration

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/pgxv5"
)

func ListRemoteMigrations(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	// We query the version string only for backwards compatibility
	rows, _ := conn.Query(ctx, LIST_MIGRATION_VERSION)
	versions, err := pgxv5.CollectStrings(rows)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UndefinedTable {
			// If migration history table is undefined, the remote project has no migrations
			return nil, nil
		}
	}
	return versions, err
}

func ListLocalMigrations(migrationsDir string, fsys fs.FS, filter ...func(string) bool) ([]string, error) {
	localMigrations, err := fs.ReadDir(fsys, migrationsDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.Errorf("failed to read directory: %w", err)
	}
	var clean []string
OUTER:
	for i, entry := range localMigrations {
		var path, version string

		if entry.IsDir() {
			dirName := entry.Name()
			matches := migrateDirPattern.FindStringSubmatch(dirName)
			if len(matches) == 0 {
				continue
			}
			// Look for migration.sql inside the directory (e.g. Drizzle v1 format)
			sqlPath := filepath.Join(migrationsDir, dirName, "migration.sql")
			if _, err := fs.Stat(fsys, sqlPath); err != nil {
				fmt.Fprintf(os.Stderr, "Skipping migration directory %s... (missing migration.sql)\n", dirName)
				continue
			}
			path = sqlPath
			version = matches[1]
		} else {
			filename := entry.Name()
			if i == 0 && shouldSkip(filename) {
				fmt.Fprintf(os.Stderr, "Skipping migration %s... (replace \"init\" with a different file name to apply this migration)\n", filename)
				continue
			}
			matches := migrateFilePattern.FindStringSubmatch(filename)
			if len(matches) == 0 {
				fmt.Fprintf(os.Stderr, "Skipping migration %s... (file name must match pattern \"<timestamp>_name.sql\")\n", filename)
				continue
			}
			path = filepath.Join(migrationsDir, filename)
			version = matches[1]
		}

		for _, keep := range filter {
			if !keep(version) {
				continue OUTER
			}
		}
		clean = append(clean, path)
	}
	return clean, nil
}

var initSchemaPattern = regexp.MustCompile(`([0-9]{14})_init\.sql`)

func shouldSkip(name string) bool {
	// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
	// the first migration (prev versions of the CLI) is deprecated.
	matches := initSchemaPattern.FindStringSubmatch(name)
	if len(matches) == 2 {
		if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err == nil && timestamp < 20211209000000 {
			return true
		}
	}
	return false
}
