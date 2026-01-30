package apply

import (
	"context"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func MigrateAndSeed(ctx context.Context, version string, conn *pgx.Conn, fsys afero.Fs) error {
	if viper.GetBool("EXPERIMENTAL") && len(version) == 0 {
		if err := applySchemaFiles(ctx, conn, afero.NewIOFS(fsys)); err != nil {
			return err
		}
	} else if err := applyMigrationFiles(ctx, version, conn, fsys); err != nil {
		return err
	}
	return applySeedFiles(ctx, conn, fsys)
}

func applyMigrationFiles(ctx context.Context, version string, conn *pgx.Conn, fsys afero.Fs) error {
	if !utils.Config.Db.Migrations.Enabled {
		return nil
	}
	migrations, err := list.LoadPartialMigrations(version, fsys)
	if err != nil {
		return err
	}
	return migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys))
}

func applySeedFiles(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	if !utils.Config.Db.Seed.Enabled {
		return nil
	}
	seeds, err := migration.GetPendingSeeds(ctx, utils.Config.Db.Seed.SqlPaths, conn, afero.NewIOFS(fsys))
	if err != nil {
		return err
	}
	return migration.SeedData(ctx, seeds, conn, afero.NewIOFS(fsys))
}

func applySchemaFiles(ctx context.Context, conn *pgx.Conn, fsys fs.FS) error {
	declared, err := utils.Config.Db.Migrations.SchemaPaths.Files(fsys)
	if len(declared) == 0 {
		return err
	}
	for _, fp := range declared {
		schema, err := migration.NewMigrationFromFile(fp, fsys)
		if err != nil {
			return err
		}
		schema.Version = ""
		if err := schema.ExecBatch(ctx, conn); err != nil {
			utils.CmdSuggestion = fmt.Sprintf("See schema file: %s", utils.Bold(fp))
			return err
		}
	}
	return nil
}
