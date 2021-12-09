package set

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"

	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

func Run(url string) error {
	if err := utils.LoadConfig(); err != nil {
		return err
	}

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
		return errors.New("Remote database Postgres version " + dbVersion + " is incompatible with " + utils.Aqua("dbVersion") + " " + utils.DbVersion + ".")
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

		conflictErr := errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold("supabase/migrations") + ".")

		if len(remoteMigrations) > len(localMigrations) {
			return conflictErr
		}

		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		for i, remoteTimestamp := range remoteMigrations {
			localTimestamp := re.FindStringSubmatch(localMigrations[i].Name())[1]

			if localTimestamp == remoteTimestamp {
				continue
			}

			return conflictErr
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
