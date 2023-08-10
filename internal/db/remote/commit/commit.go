package commit

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(ctx); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
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
	p.Send(utils.StatusMsg("Connecting to remote database..."))
	conn, err := utils.ConnectRemotePostgres(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := assertRemoteInSync(ctx, conn, fsys); err != nil {
		return err
	}

	// 2. Fetch remote schema changes
	if len(schema) == 0 {
		schema, err = diff.LoadUserSchemas(ctx, conn)
		if err != nil {
			return err
		}
	}
	timestamp := utils.GetCurrentTimestamp()
	if err := fetchRemote(p, ctx, schema, timestamp, config, fsys); err != nil {
		return err
	}

	// 3. Insert a row to `schema_migrations`
	return repair.UpdateMigrationTable(ctx, conn, timestamp, repair.Applied, fsys)
}

func fetchRemote(p utils.Program, ctx context.Context, schema []string, timestamp string, config pgconn.Config, fsys afero.Fs) error {
	path := filepath.Join(utils.MigrationsDir, timestamp+"_remote_commit.sql")
	// Special case if this is the first migration
	if migrations, err := list.LoadLocalMigrations(fsys); err != nil {
		return err
	} else if len(migrations) == 0 {
		p.Send(utils.StatusMsg("Committing initial migration on remote database..."))
		return dump.Run(ctx, path, config, nil, false, false, false, false, false, fsys)
	}

	w := utils.StatusWriter{Program: p}
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	output, err := diff.DiffDatabase(ctx, schema, config, w, fsys)
	if err != nil {
		return err
	}
	if len(output) == 0 {
		return errors.New("no schema changes found")
	}
	return afero.WriteFile(fsys, path, []byte(output), 0644)
}

func assertRemoteInSync(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	remoteMigrations, err := list.LoadRemoteMigrations(ctx, conn)
	if err != nil {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != pgerrcode.UndefinedTable {
			return err
		}
	}
	localMigrations, err := list.LoadLocalMigrations(fsys)
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
		// LoadLocalMigrations guarantees we always have a match
		localTimestamp := utils.MigrateFilePattern.FindStringSubmatch(localMigrations[i])[1]
		if localTimestamp != remoteTimestamp {
			return conflictErr
		}
	}

	return nil
}
