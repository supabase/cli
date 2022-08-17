package set

import (
	"context"
	"errors"
	"fmt"
	u "net/url"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const (
	CHECK_MIGRATION_EXISTS = "SELECT 1 FROM supabase_migrations.schema_migrations LIMIT 1"
	LIST_MIGRATION_VERSION = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"
	CREATE_MIGRATION_TABLE = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
`
)

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func Run(url string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}

	matches := utils.PostgresUrlPattern.FindStringSubmatch(url)
	if len(matches) != 3 {
		return errors.New("URL is not a valid Supabase connection string.")
	}
	url = "postgresql://postgres:" + u.QueryEscape(matches[1]) + "@" + matches[2] + "/postgres"

	config, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}

	// Simple protocol is preferred over pgx default Parse -> Bind flow because
	//   1. Using a single command for each query reduces RTT over an Internet connection.
	//   2. Performance gains from using the alternate binary protocol is negligible because
	//      we are only selecting from migrations table. Large reads are handled by PostgREST.
	//   3. Any prepared statements are cleared server side upon closing the TCP connection.
	//      Since CLI workloads are one-off scripts, we don't use connection pooling and hence
	//      don't benefit from per connection server side cache.
	config.PreferSimpleProtocol = true
	for _, op := range options {
		op(config)
	}

	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	// 1. Assert db.major_version is compatible.
	serverVersion := conn.PgConn().ParameterStatus("server_version")
	// Safe to assume that supported Postgres version is 10.0 <= n < 100.0
	dbMajorVersion, err := strconv.ParseUint(serverVersion[:min(2, len(serverVersion))], 10, 7)
	if err != nil {
		return err
	}

	if dbMajorVersion != uint64(utils.Config.Db.MajorVersion) {
		return fmt.Errorf(
			"Remote database Postgres version %[1]d is incompatible with %[3]s %[2]d. If you are setting up a fresh Supabase CLI project, try changing %[3]s in %[4]s to %[1]d.",
			dbMajorVersion,
			utils.Config.Db.MajorVersion,
			utils.Aqua("db.major_version"),
			utils.Bold(utils.ConfigPath),
		)
	}

	// 2. Setup & validate `schema_migrations`.

	// If `schema_migrations` doesn't exist on the remote database, create it.
	if _, err := conn.Exec(ctx, CHECK_MIGRATION_EXISTS); err != nil {
		if _, err := conn.Exec(ctx, CREATE_MIGRATION_TABLE); err != nil {
			return err
		}
	}

	// If `schema_migrations` is not a "prefix" of list of migrations in repo, fail &
	// warn user.
	rows, err := conn.Query(ctx, LIST_MIGRATION_VERSION)
	if err != nil {
		return err
	} else {
		var remoteMigrations []string
		for rows.Next() {
			var version string
			if err := rows.Scan(&version); err != nil {
				return err
			}
			remoteMigrations = append(remoteMigrations, version)
		}

		if err := utils.MkdirIfNotExistFS(fsys, "supabase/migrations"); err != nil {
			return err
		}
		localMigrations, err := afero.ReadDir(fsys, "supabase/migrations")
		if err != nil {
			return err
		}

		for i, remoteTimestamp := range remoteMigrations {
			if i >= len(localMigrations) {
				return errors.New(`The remote database was applied with migration(s) that cannot be found locally. Try updating the project from version control. Otherwise:
1. Delete rows from supabase_migrations.schema_migrations on the remote database so that it's in sync with the contents of ` + utils.Bold("supabase/migrations") + `,
2. Run ` + utils.Aqua("supabase db remote set") + ` again,
3. Run ` + utils.Aqua("supabase db remote commit") + ".")
			}

			localTimestamp := utils.MigrateFilePattern.FindStringSubmatch(localMigrations[i].Name())
			if len(localTimestamp) > 1 && localTimestamp[1] == remoteTimestamp {
				continue
			}

			return errors.New(`The remote database was set up with a different Supabase CLI project. If you meant to reset the migration history to use a new Supabase CLI project:
1. Run ` + utils.Aqua("DROP SCHEMA supabase_migrations CASCADE") + ` on the remote database,
2. Run ` + utils.Aqua("supabase db remote set") + ` again,
3. Run ` + utils.Aqua("supabase db remote commit") + ".")
		}
	}
	rows.Close()

	// 3. Write .env
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.RemoteDbPath)); err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, utils.RemoteDbPath, []byte(url), 0600); err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db remote set") + ".")
	return nil
}
