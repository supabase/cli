package migration

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
)

// Find all files that match the specified glob patterns without duplicates.
// Results are ordered by input glob pattern, followed by lexical order.
func FindSeedFiles(globs []string, fsys fs.FS) ([]string, error) {
	var files []string
	for _, pattern := range globs {
		matches, err := fs.Glob(fsys, pattern)
		if err != nil {
			return nil, errors.Errorf("failed to apply glob pattern: %w", err)
		}
		sort.Strings(matches)
		files = append(files, matches...)
	}
	return removeDuplicates(files), nil
}

func removeDuplicates[T comparable](slice []T) []T {
	// Remove elements in-place
	result := slice[:0]
	set := make(map[T]struct{})
	for _, item := range slice {
		if _, exists := set[item]; !exists {
			set[item] = struct{}{}
			result = append(result, item)
		}
	}
	return result
}

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
