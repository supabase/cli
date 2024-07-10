package apply

import (
	"context"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
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
	err := migration.SeedData(ctx, []string{utils.SeedDataPath}, conn, afero.NewIOFS(fsys))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func MigrateUp(ctx context.Context, conn *pgx.Conn, pending []string, fsys afero.Fs) error {
	var paths []string
	for _, name := range pending {
		paths = append(paths, filepath.Join(utils.MigrationsDir, name))
	}
	return migration.ApplyMigrations(ctx, paths, conn, afero.NewIOFS(fsys))
}

func CreateCustomRoles(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	err := migration.SeedGlobals(ctx, []string{utils.CustomRolesPath}, conn, afero.NewIOFS(fsys))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
