package push

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, dryRun bool, username, password, database string, fsys afero.Fs) error {
	if dryRun {
		fmt.Println("DRY RUN: migrations will *not* be pushed to the database.")
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertIsLinkedFS(fsys); err != nil {
		return err
	}

	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	conn, err := commit.ConnectRemotePostgres(ctx, username, password, database, projectRef)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// Assert db.major_version is compatible.
	if err := commit.AssertPostgresVersionMatch(conn); err != nil {
		return err
	}

	// If `schema_migrations` is not a "prefix" of list of migrations in repo, fail & warn user.
	rows, err := conn.Query(ctx, commit.LIST_MIGRATION_VERSION)
	if err != nil {
		return fmt.Errorf(`Error querying remote database: %w.
Try running `+utils.Aqua("supabase link")+" to reinitialise the project.", err)
	}

	versions := []string{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		versions = append(versions, version)
	}

	migrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
	if err != nil {
		return fmt.Errorf(`No migrations found: %w.
Try running `+utils.Aqua("supabase migration new")+".", err)
	}

	conflictErr := errors.New("supabase_migrations.schema_migrations table conflicts with the contents of " + utils.Bold(utils.MigrationsDir) + ".")
	if len(versions) > len(migrations) {
		return fmt.Errorf("%w; Found %d versions and %d migrations.", conflictErr, len(versions), len(migrations))
	}

	if !dryRun {
		fmt.Println("Applying unapplied migrations...")
	}

	for i, migration := range migrations {
		matches := utils.MigrateFilePattern.FindStringSubmatch(migration.Name())
		if len(matches) == 0 {
			return errors.New("Can't process file in " + utils.MigrationsDir + ": " + migration.Name())
		}

		migrationTimestamp := matches[1]

		if i >= len(versions) {
			// skip
		} else if versions[i] == migrationTimestamp {
			continue
		} else {
			return fmt.Errorf("%w; Expected version %s but found migration %s at index %d.", conflictErr, versions[i], migrationTimestamp, i)
		}

		f, err := afero.ReadFile(fsys, filepath.Join(utils.MigrationsDir, migration.Name()))
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
				// Insert a row to `schema_migrations`
				if _, err := conn.Exec(ctx, commit.INSERT_MIGRATION_VERSION, migrationTimestamp); err != nil {
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
