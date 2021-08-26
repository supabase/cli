package deploy

import (
	"context"
	"errors"
	"os"
	"regexp"

	pgx "github.com/jackc/pgx/v4"
)

var ctx = context.TODO()

func Deploy() error {
	url := os.Getenv("SUPABASE_DEPLOY_DB_URL")
	if url == "" {
		return errors.New("❌ SUPABASE_DEPLOY_DB_URL is not set.")
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// apply unapplied migrations based on `schema_migrations` table and `migrations` dir
	rows, err := conn.Query(ctx, "SELECT version FROM supabase_migrations.schema_migrations")
	if err != nil {
		return errors.New("❌ supabase_migrations.schema_migrations table does not exist.")
	}

	versions := []string{}
	for rows.Next() {
		var version string
		rows.Scan(&version)
		versions = append(versions, version)
	}

	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		return err
	}

	conflictErr := errors.New(
		"❌ supabase_migrations.schema_migrations table conflicts with the contents of `migrations` directory.",
	)

	if len(versions) > len(migrations) {
		return conflictErr
	}

	for i, migration := range migrations {
		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		migrationTimestamp := re.FindStringSubmatch(migration.Name())[1]

		if i >= len(versions) {
			// skip
		} else if versions[i] == migrationTimestamp {
			continue
		} else {
			return conflictErr
		}

		f, err := os.ReadFile("supabase/migrations/" + migration.Name())
		if err != nil {
			return err
		}

		if _, err := conn.Exec(
			ctx,
			"BEGIN;"+
				string(f)+
				"INSERT INTO supabase_migrations.schema_migrations(version) VALUES('"+migrationTimestamp+"');"+
				"COMMIT;",
		); err != nil {
			return err
		}
	}

	return nil
}
