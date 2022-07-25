package push

import (
	"context"
	"errors"
	"fmt"
	"os"

	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(dryRun bool) error {
	if dryRun {
		fmt.Println("DRY RUN: migrations will *not* be pushed to the database.")
	}
	urlBytes, err := os.ReadFile(utils.RemoteDbPath)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("Remote database is not set. Run " + utils.Aqua("supabase db remote set") + " first.")
	} else if err != nil {
		return err
	}
	url := string(urlBytes)

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

	if err := utils.MkdirIfNotExist("supabase/migrations"); err != nil {
		return err
	}
	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		return err
	}

	conflictErr := errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold("supabase/migrations") + ".")

	if len(versions) > len(migrations) {
		return fmt.Errorf("%w; Found %d versions and %d migrations.", conflictErr, len(versions), len(migrations))
	}

	if !dryRun {
		fmt.Println("Applying unapplied migrations...")
	}

	for i, migration := range migrations {
		matches := utils.MigrateFilePattern.FindStringSubmatch(migration.Name())
		if len(matches) == 0 {
			return errors.New("Can't process file in supabase/migrations: " + migration.Name())
		}

		migrationTimestamp := matches[1]

		if i >= len(versions) {
			// skip
		} else if versions[i] == migrationTimestamp {
			continue
		} else {
			return fmt.Errorf("%w; Expected version %s but found migration %s at index %d.", conflictErr, versions[i], migrationTimestamp, i)
		}

		f, err := os.ReadFile("supabase/migrations/" + migration.Name())
		if err != nil {
			return err
		}

		if err := func() error {
			tx, err := conn.Begin(ctx)
			if err != nil {
				return fmt.Errorf("%w; while beginning migration %s", err, migrationTimestamp)
			}
			defer tx.Rollback(context.Background()) //nolint:errcheck

			if dryRun {
				fmt.Printf("Would apply migration %s:\n%s\n\n---\n\n", migration.Name(), f)
			} else {
				if _, err := tx.Exec(ctx, string(f)); err != nil {
					return fmt.Errorf("%w; while executing migration %s", err, migrationTimestamp)
				}
				if _, err := tx.Exec(ctx, "INSERT INTO supabase_migrations.schema_migrations(version) VALUES('"+migrationTimestamp+"');"); err != nil {
					return fmt.Errorf("%w; while inserting migration %s", err, migrationTimestamp)
				}

				if err := tx.Commit(ctx); err != nil {
					return fmt.Errorf("%w; while committing migration %s", err, migrationTimestamp)
				}
			}

			return nil
		}(); err != nil {
			return err
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}
