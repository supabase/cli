package migration

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/config"
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

func GetPendingSeeds(ctx context.Context, locals config.Glob, conn *pgx.Conn, fsys fs.FS) ([]SeedFile, error) {
	locals, err := locals.Files(fsys)
	if err != nil {
		fmt.Fprintln(os.Stderr, "WARN:", err)
	}
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

func SeedData(ctx context.Context, pending []SeedFile, conn *pgx.Conn, fsys fs.FS) error {
	if len(pending) > 0 {
		if err := CreateSeedTable(ctx, conn); err != nil {
			return err
		}
	}
	for _, seed := range pending {
		if seed.Dirty {
			fmt.Fprintf(os.Stderr, "Updating seed hash to %s...\n", seed.Path)
		} else {
			fmt.Fprintf(os.Stderr, "Seeding data from %s...\n", seed.Path)
		}
		// Batch seed commands, safe to use statement cache
		if err := seed.ExecBatchWithCache(ctx, conn, fsys); err != nil {
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
