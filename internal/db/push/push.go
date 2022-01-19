package push

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"

	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run() error {
	url := os.Getenv("SUPABASE_REMOTE_DB_URL")
	if url == "" {
		return errors.New("Remote database is not set. Run " + utils.Aqua("supabase db remote set") + " first.")
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// `schema_migrations` must be a "prefix" of `supabase/migrations`.

	rows, err := conn.Query(ctx, "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf(`Error querying remote database: %w.
Try running `+utils.Aqua("supabase db remote set")+".", err)
	}

	versions := []string{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		versions = append(versions, version)
	}

	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		return err
	}

	conflictErr := errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold("supabase/migrations") + ".")

	if len(versions) > len(migrations) {
		return conflictErr
	}

	fmt.Println("Applying unapplied migrations...")

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

		if err := func() error {
			tx, err := conn.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx) //nolint:errcheck

			if _, err := tx.Exec(ctx, string(f)); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO supabase_migrations.schema_migrations(version) VALUES('"+migrationTimestamp+"');"); err != nil {
				return err
			}

			if err := tx.Commit(ctx); err != nil {
				return err
			}

			return nil
		}(); err != nil {
			return err
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}
