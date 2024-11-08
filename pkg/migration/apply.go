package migration

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
)

var (
	ErrMissingRemote = errors.New("Found local migration files to be inserted before the last migration on remote database.")
	ErrMissingLocal  = errors.New("Remote migration versions not found in local migrations directory.")
)

// Find unapplied local migrations older than the latest migration on
// remote, and remote migrations that are missing from local.
func FindPendingMigrations(localMigrations, remoteMigrations []string) ([]string, error) {
	var unapplied, missing []string
	i, j := 0, 0
	for i < len(remoteMigrations) && j < len(localMigrations) {
		remote := remoteMigrations[i]
		filename := filepath.Base(localMigrations[j])
		// Check if migration has been applied before, LoadLocalMigrations guarantees a match
		local := migrateFilePattern.FindStringSubmatch(filename)[1]
		if remote == local {
			j++
			i++
		} else if remote < local {
			missing = append(missing, remote)
			i++
		} else {
			// Include out-of-order local migrations
			unapplied = append(unapplied, localMigrations[j])
			j++
		}
	}
	// Ensure all remote versions exist on local
	if j == len(localMigrations) {
		missing = append(missing, remoteMigrations[i:]...)
	}
	if len(missing) > 0 {
		return missing, errors.New(ErrMissingLocal)
	}
	// Enforce migrations are applied in chronological order by default
	if len(unapplied) > 0 {
		return unapplied, errors.New(ErrMissingRemote)
	}
	pending := localMigrations[len(remoteMigrations):]
	return pending, nil
}

func ApplyMigrations(ctx context.Context, pending []string, conn *pgx.Conn, fsys fs.FS) error {
	if len(pending) > 0 {
		if err := CreateMigrationTable(ctx, conn); err != nil {
			return err
		}
	}
	for _, path := range pending {
		filename := filepath.Base(path)
		fmt.Fprintf(os.Stderr, "Applying migration %s...\n", filename)
		if migration, err := NewMigrationFromFile(path, fsys); err != nil {
			return err
		} else if err := migration.ExecBatch(ctx, conn); err != nil {
			return err
		}
	}
	return nil
}
