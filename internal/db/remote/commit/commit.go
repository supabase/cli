package commit

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, schema []string, username, password, database string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}

	return utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, username, password, database, fsys)
	})
}

func run(p utils.Program, ctx context.Context, schema []string, username, password, database string, fsys afero.Fs) error {
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	host := utils.GetSupabaseDbHost(projectRef)

	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, host)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := AssertRemoteInSync(ctx, conn, fsys); err != nil {
		return err
	}

	// 2. Fetch remote schema changes
	timestamp := utils.GetCurrentTimestamp()
	if err := fetchRemote(p, ctx, schema, timestamp, username, password, database, host, fsys); err != nil {
		return err
	}

	// 3. Insert a row to `schema_migrations`
	if _, err = conn.Exec(ctx, repair.INSERT_MIGRATION_VERSION, timestamp); err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db remote commit") + ".")
	return nil
}

func fetchRemote(p utils.Program, ctx context.Context, schema []string, timestamp, username, password, database, host string, fsys afero.Fs) error {
	path := filepath.Join(utils.MigrationsDir, timestamp+"_remote_commit.sql")
	// Special case if this is the first migration
	if migrations, err := list.LoadLocalMigrations(fsys); err != nil {
		return err
	} else if len(migrations) == 0 {
		p.Send(utils.StatusMsg("Committing initial migration on remote database..."))
		return dump.Run(ctx, path, username, password, database, host, fsys)
	}

	p.Send(utils.StatusMsg("Pulling images..."))

	for _, image := range []string{utils.DbImage, utils.DifferImage} {
		if err := utils.DockerPullImageIfNotCached(ctx, image); err != nil {
			return err
		}
	}

	// Create shadow db and run migrations.
	p.Send(utils.StatusMsg("Creating shadow database..."))

	shadow, err := diff.CreateShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := diff.MigrateShadowDatabase(ctx, fsys); err != nil {
		return err
	}

	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	p.Send(utils.StatusMsg("Committing changes on remote database as a new migration..."))

	source := "postgresql://postgres:postgres@" + shadow[:12] + ":5432/postgres"
	target := fmt.Sprintf("postgresql://%s@%s:6543/postgres", url.UserPassword(database, password), host)
	diff, err := diff.DiffSchemaMigra(ctx, source, target, schema)
	if err != nil {
		return err
	}
	return afero.WriteFile(fsys, path, []byte(diff), 0644)
}

func AssertRemoteInSync(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	remoteMigrations, err := list.LoadRemoteMigrations(ctx, conn)
	if err != nil {
		return err
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
