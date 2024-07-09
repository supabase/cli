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
		filename := filepath.Base(path)
		fmt.Fprintf(os.Stderr, "Seeding data %s...", filename)
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
		fmt.Fprintf(os.Stderr, "Seeding globals %s...", filename)
		if globals, err := NewMigrationFromFile(path, fsys); err != nil {
			return err
		} else if err := globals.ExecBatch(ctx, conn); err != nil {
			return err
		}
	}
	return nil
}
