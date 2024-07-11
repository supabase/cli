package commit

import (
	"context"
	_ "embed"
	"fmt"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, config, fsys)
	}); err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db remote commit") + ".")
	return nil
}

func run(p utils.Program, ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	w := utils.StatusWriter{Program: p}
	conn, err := utils.ConnectByConfigStream(ctx, config, w)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := assertRemoteInSync(ctx, conn, fsys); err != nil {
		return err
	}

	// 2. Fetch remote schema changes
	if len(schema) == 0 {
		schema, err = migration.ListUserSchemas(ctx, conn)
		if err != nil {
			return err
		}
	}
	timestamp := utils.GetCurrentTimestamp()
	if err := fetchRemote(p, ctx, schema, timestamp, config, fsys); err != nil {
		return err
	}

	// 3. Insert a row to `schema_migrations`
	return repair.UpdateMigrationTable(ctx, conn, []string{timestamp}, repair.Applied, false, fsys)
}

func fetchRemote(p utils.Program, ctx context.Context, schema []string, timestamp string, config pgconn.Config, fsys afero.Fs) error {
	path := filepath.Join(utils.MigrationsDir, timestamp+"_remote_commit.sql")
	// Special case if this is the first migration
	if migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys)); err != nil {
		return err
	} else if len(migrations) == 0 {
		p.Send(utils.StatusMsg("Committing initial migration on remote database..."))
		return dump.Run(ctx, path, config, nil, nil, false, false, false, false, false, fsys)
	}

	w := utils.StatusWriter{Program: p}
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	output, err := diff.DiffDatabase(ctx, schema, config, w, fsys, diff.DiffSchemaMigra)
	if err != nil {
		return err
	}
	if len(output) == 0 {
		return errors.New("No schema changes found")
	}
	return utils.WriteFile(path, []byte(output), fsys)
}

func assertRemoteInSync(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	remoteMigrations, err := migration.ListRemoteMigrations(ctx, conn)
	if err != nil {
		return err
	}
	localMigrations, err := list.LoadLocalVersions(fsys)
	if err != nil {
		return err
	}

	conflictErr := errors.New("The remote database's migration history is not in sync with the contents of " + utils.Bold(utils.MigrationsDir) + `. Resolve this by:
- Updating the project from version control to get the latest ` + utils.Bold(utils.MigrationsDir) + `,
- Pushing unapplied migrations with ` + utils.Aqua("supabase db push") + `,
- Or failing that, manually editing supabase_migrations.schema_migrations table with ` + utils.Aqua("supabase migration repair") + ".")
	if len(remoteMigrations) != len(localMigrations) {
		return conflictErr
	}

	for i, remoteTimestamp := range remoteMigrations {
		if localMigrations[i] != remoteTimestamp {
			return conflictErr
		}
	}

	return nil
}
