package pull

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
)

var (
	errConflict = errors.New("The remote database's migration history is not in sync with the contents of " + utils.Bold(utils.MigrationsDir) + `. Resolve this by:
- Updating the project from version control to get the latest ` + utils.Bold(utils.MigrationsDir) + `,
- Pushing unapplied migrations with ` + utils.Aqua("supabase db push") + `,
- Or failing that, manually editing supabase_migrations.schema_migrations table with ` + utils.Aqua("supabase migration repair") + ".")
	errMissing = errors.New("no migrations found")
	errInSync  = errors.New("no schema changes found")
)

func Run(ctx context.Context, schema []string, config pgconn.Config, name string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Sanity checks.
	if err := utils.AssertDockerIsRunning(ctx); err != nil {
		return err
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// 2. Check postgres connection
	fmt.Fprintln(os.Stderr, "Connecting to remote database...")
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// 3. Pull schema
	timestamp := utils.GetCurrentTimestamp()
	path := new.GetMigrationPath(timestamp, name)
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, path, conn, fsys)
	}); err != nil {
		return err
	}
	// 4. Insert a row to `schema_migrations`
	fmt.Fprintln(os.Stderr, "Schema written to "+utils.Bold(path))
	if shouldUpdate := utils.PromptYesNo("Update remote migration history table?", true, os.Stdin); shouldUpdate {
		return repair.UpdateMigrationTable(ctx, conn, timestamp, repair.Applied, fsys)
	}
	return nil
}

func run(p utils.Program, ctx context.Context, schema []string, path string, conn *pgx.Conn, fsys afero.Fs) error {
	config := conn.Config().Config
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := assertRemoteInSync(ctx, conn, fsys); err == errMissing {
		return dumpRemoteSchema(p, ctx, path, config, fsys)
	} else if err != nil {
		return err
	}
	// 2. Fetch remote schema changes
	if len(schema) == 0 {
		var err error
		schema, err = diff.LoadUserSchemas(ctx, conn)
		if err != nil {
			return err
		}
	}
	return diffRemoteSchema(p, ctx, schema, path, config, fsys)
}

func dumpRemoteSchema(p utils.Program, ctx context.Context, path string, config pgconn.Config, fsys afero.Fs) error {
	// Special case if this is the first migration
	p.Send(utils.StatusMsg("Dumping schema from remote database..."))
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	return dump.DumpSchema(ctx, config, nil, false, false, f)
}

func diffRemoteSchema(p utils.Program, ctx context.Context, schema []string, path string, config pgconn.Config, fsys afero.Fs) error {
	w := utils.StatusWriter{Program: p}
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	output, err := diff.DiffDatabase(ctx, schema, config, w, fsys)
	if err != nil {
		return err
	}
	if len(output) == 0 {
		return errInSync
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

	if len(remoteMigrations) != len(localMigrations) {
		return errConflict
	}
	for i, remoteTimestamp := range remoteMigrations {
		// LoadLocalMigrations guarantees we always have a match
		localTimestamp := utils.MigrateFilePattern.FindStringSubmatch(localMigrations[i])[1]
		if localTimestamp != remoteTimestamp {
			return errConflict
		}
	}

	if len(localMigrations) == 0 {
		return errMissing
	}
	return nil
}
