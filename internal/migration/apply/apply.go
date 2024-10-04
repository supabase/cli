package apply

import (
	"context"
	"os"

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
	if err := migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys)); err != nil {
		return err
	}
	return SeedDatabase(ctx, conn, fsys)
}

func SeedDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	if !utils.Config.Db.Seed.Enabled {
		return nil
	}
	seeds, err := migration.GetPendingSeeds(ctx, utils.Config.Db.Seed.SqlPaths, conn, afero.NewIOFS(fsys))
	if err != nil {
		return err
	}
	return migration.SeedData(ctx, seeds, conn, afero.NewIOFS(fsys))
}

func CreateCustomRoles(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	err := migration.SeedGlobals(ctx, []string{utils.CustomRolesPath}, conn, afero.NewIOFS(fsys))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
