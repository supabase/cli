package apply

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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
	return applySeedFiles(ctx, conn, fsys)
}

func applySeedFiles(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	remote, _ := utils.Config.GetRemoteByProjectRef(flags.ProjectRef)
	if !remote.Db.Seed.Enabled {
		fmt.Fprintln(os.Stderr, "Skipping seed because it is disabled in config.toml for project:", remote.ProjectId)
		return nil
	}
	seeds, err := migration.GetPendingSeeds(ctx, remote.Db.Seed.SqlPaths, conn, afero.NewIOFS(fsys))
	if err != nil {
		return err
	}
	return migration.SeedData(ctx, seeds, conn, afero.NewIOFS(fsys))
}
