package migration

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v4"
)

func SeedData(ctx context.Context, pending []string, conn *pgx.Conn, fsys fs.FS) error {
	for _, path := range pending {
		fmt.Fprintf(os.Stderr, "Seeding data from %s...\n", path)
		// Batch seed commands, safe to use statement cache
		if seed, err := NewMigrationFromFile(path, fsys); err != nil {
			return err
		} else if err := seed.ExecBatchWithCache(ctx, conn); err != nil {
			return err
		}
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
