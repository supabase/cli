package set

import (
	"context"
	"errors"
	"fmt"
	u "net/url"
	"os"
	"regexp"

	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

func Run(url string) error {
	// Sanity checks.
	{
		if err := utils.LoadConfig(); err != nil {
			return err
		}
	}

	matches := regexp.MustCompile(`^postgres(?:ql)?://postgres:(.+)@(.+?)(:\d+)?/postgres$`).FindStringSubmatch(url)
	if len(matches) != 4 {
		return errors.New("URL is not a valid Supabase connection string.")
	}
	url = "postgresql://postgres:" + u.QueryEscape(matches[1]) + "@" + u.QueryEscape(matches[2]) + matches[3] + "/postgres"

	ctx := context.Background()

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// 1. Assert dbVersion is compatible.
	var dbVersion string
	if err := conn.QueryRow(ctx, "SELECT current_setting('server_version_num')").Scan(&dbVersion); err != nil {
		return err
	}
	if dbVersion[:2] != utils.DbVersion[:2] {
		return errors.New("Remote database Postgres version " + dbVersion + " is incompatible with " + utils.Aqua("dbVersion") + " " + utils.DbVersion + ". If you are setting up a fresh Supabase CLI project, try changing " + utils.Aqua("dbVersion") + " in " + utils.Bold("supabase/config.json") + " to " + dbVersion + ".")
	}

	// 2. Setup & validate `schema_migrations`.

	// If `schema_migrations` doesn't exist on the remote database, create it.
	if _, err := conn.Exec(ctx, "SELECT 1 FROM supabase_migrations.schema_migrations"); err != nil {
		if _, err := conn.Exec(
			ctx,
			`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
`,
		); err != nil {
			return err
		}
	}

	// If `schema_migrations` is not a "prefix" of list of migrations in repo, fail &
	// warn user.
	rows, err := conn.Query(ctx, "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")
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

		localMigrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		for i, remoteTimestamp := range remoteMigrations {
			if i >= len(localMigrations) {
				return errors.New(`The remote database was applied with migration(s) that cannot be found locally. Try updating the project from version control. Otherwise:
1. Delete rows from supabase_migrations.schema_migrations on the remote database so that it's in sync with the contents of ` + utils.Bold("supabase/migrations") + `,
2. Run ` + utils.Aqua("supabase db remote set") + ` again,
3. Run ` + utils.Aqua("supabase db remote commit") + ".")
			}

			localTimestamp := re.FindStringSubmatch(localMigrations[i].Name())[1]

			if localTimestamp == remoteTimestamp {
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
	if err := os.WriteFile("supabase/.env", []byte("SUPABASE_REMOTE_DB_URL="+url), 0644); err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db remote set") + ".")
	return nil
}
