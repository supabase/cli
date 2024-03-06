package apply

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
)

func MigrateAndSeed(ctx context.Context, version string, conn *pgx.Conn, fsys afero.Fs) error {
	migrations, err := list.LoadPartialMigrations(version, fsys)
	if err != nil {
		return err
	}
	if err := MigrateUp(ctx, conn, migrations, fsys); err != nil {
		return err
	}
	return SeedDatabase(ctx, conn, fsys)
}

func SeedDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	seed, err := repair.NewMigrationFromFile(utils.SeedDataPath, fsys)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Seeding data "+utils.Bold(utils.SeedDataPath)+"...")
	// Batch seed commands, safe to use statement cache
	return seed.ExecBatchWithCache(ctx, conn)
}

func MigrateUp(ctx context.Context, conn *pgx.Conn, pending []string, fsys afero.Fs) error {
	if len(pending) > 0 {
		if err := repair.CreateMigrationTable(ctx, conn); err != nil {
			return err
		}
	}
	for _, filename := range pending {
		if err := applyMigration(ctx, conn, filename, fsys); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, conn *pgx.Conn, filename string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Applying migration "+utils.Bold(filename)+"...")
	path := filepath.Join(utils.MigrationsDir, filename)
	migration, err := repair.NewMigrationFromFile(path, fsys)
	if err != nil {
		return err
	}
	return migration.ExecBatch(ctx, conn)
}

func BatchExecDDL(ctx context.Context, conn *pgx.Conn, sql io.Reader) error {
	migration, err := repair.NewMigrationFromReader(sql)
	if err != nil {
		return err
	}
	return migration.ExecBatch(ctx, conn)
}
