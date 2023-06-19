package squash

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if _, err := strconv.Atoi(version); err != nil {
		return errors.New("invalid version number")
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// 1. Dump migrated shadow database
	migrations, err := list.LoadPartialMigrations(version, fsys)
	if err != nil {
		return err
	}
	if err := squashMigrations(ctx, migrations, fsys, options...); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Squashed migration history to", version)
	// 2. Remove merged files
	for _, name := range migrations[:len(migrations)-1] {
		path := filepath.Join(utils.MigrationsDir, name)
		if err := fsys.Remove(path); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	// 3. Update migration history
	if len(config.Host) == 0 {
		return nil
	}
	fmt.Fprintln(os.Stderr, "Baselining migration history to", version)
	return baselineMigrations(ctx, config, version, fsys)
}

func squashMigrations(ctx context.Context, migrations []string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Start shadow database
	shadow, err := diff.CreateShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	// 2. Migrate to target version
	if err := diff.MigrateShadowDatabaseVersions(ctx, shadow, migrations, fsys, options...); err != nil {
		return err
	}
	// 3. Dump migrated schema
	path := filepath.Join(utils.MigrationsDir, migrations[len(migrations)-1])
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	config := pgconn.Config{
		Host:     "localhost",
		Port:     uint16(utils.Config.Db.ShadowPort),
		User:     "postgres",
		Password: utils.Config.Db.Password,
	}
	return dump.DumpSchema(ctx, config, false, f)
}

const DELETE_MIGRATION_BEFORE = "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1"

func baselineMigrations(ctx context.Context, config pgconn.Config, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := repair.CreateMigrationTable(ctx, conn); err != nil {
		return err
	}
	m, err := repair.NewMigrationFromVersion(version, fsys)
	if err != nil {
		return err
	}
	// Data statements don't mutate schemas, safe to use statement cache
	batch := pgx.Batch{}
	batch.Queue(DELETE_MIGRATION_BEFORE, version)
	batch.Queue(repair.INSERT_MIGRATION_VERSION, version, m.Lines)
	return conn.SendBatch(ctx, &batch).Close()
}
