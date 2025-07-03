package squash

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var ErrMissingVersion = errors.New("version not found")

func Run(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(version) > 0 {
		if _, err := strconv.Atoi(version); err != nil {
			return errors.New(repair.ErrInvalidVersion)
		}
		if _, err := repair.GetMigrationFile(version, fsys); err != nil {
			return err
		}
	}
	// 1. Squash local migrations
	if err := squashToVersion(ctx, version, fsys, options...); err != nil {
		return err
	}
	// 2. Update migration history
	if utils.IsLocalDatabase(config) {
		return nil
	}
	if shouldUpdate, err := utils.NewConsole().PromptYesNo(ctx, "Update remote migration history table?", true); err != nil {
		return err
	} else if !shouldUpdate {
		return nil
	}
	return baselineMigrations(ctx, config, version, fsys, options...)
}

func squashToVersion(ctx context.Context, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	migrations, err := list.LoadPartialMigrations(version, fsys)
	if err != nil {
		return err
	}
	if len(migrations) == 0 {
		return errors.New(ErrMissingVersion)
	}
	// Migrate to target version and dump
	local := migrations[len(migrations)-1]
	if len(migrations) == 1 {
		fmt.Fprintln(os.Stderr, utils.Bold(local), "is already the earliest migration.")
		return nil
	}
	if err := squashMigrations(ctx, migrations, fsys, options...); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Squashed local migrations to", utils.Bold(local))
	// Remove merged files
	for _, path := range migrations[:len(migrations)-1] {
		if err := fsys.Remove(path); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	return nil
}

func squashMigrations(ctx context.Context, migrations []string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Start shadow database
	shadow, err := diff.CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, shadow); err != nil {
		return err
	}
	conn, err := diff.ConnectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := start.SetupDatabase(ctx, conn, shadow[:12], os.Stderr, fsys); err != nil {
		return err
	}
	// Assuming entities in managed schemas are not altered, we can simply diff the dumps before and after migrations.
	opt := migration.WithSchema("auth", "storage")
	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	var before, after bytes.Buffer
	if err := migration.DumpSchema(ctx, config, &before, dump.DockerExec, opt); err != nil {
		return err
	}
	// 2. Migrate to target version
	if err := migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys)); err != nil {
		return err
	}
	if err := migration.DumpSchema(ctx, config, &after, dump.DockerExec, opt); err != nil {
		return err
	}
	// 3. Dump migrated schema
	path := migrations[len(migrations)-1]
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open migration file: %w", err)
	}
	defer f.Close()
	if err := migration.DumpSchema(ctx, config, f, dump.DockerExec); err != nil {
		return err
	}
	// 4. Append managed schema diffs
	fmt.Fprint(f, separatorComment)
	return lineByLineDiff(&before, &after, f)
}

const separatorComment = `
--
-- Dumped schema changes for auth and storage
--

`

func lineByLineDiff(before, after io.Reader, f io.Writer) error {
	anchor := bufio.NewScanner(before)
	anchor.Scan()
	// Assuming before is always a subset of after
	scanner := bufio.NewScanner(after)
	for scanner.Scan() {
		line := scanner.Text()
		if line == anchor.Text() {
			anchor.Scan()
			continue
		}
		if _, err := fmt.Fprintln(f, line); err != nil {
			return errors.Errorf("failed to write line: %w", err)
		}
	}
	return nil
}

func baselineMigrations(ctx context.Context, config pgconn.Config, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(version) == 0 {
		// Expecting no errors here because the caller should have handled them
		if localVersions, err := list.LoadLocalVersions(fsys); len(localVersions) > 0 {
			version = localVersions[0]
		} else if err != nil {
			logger := utils.GetDebugLogger()
			fmt.Fprintln(logger, err)
		}
	}
	fmt.Fprintln(os.Stderr, "Baselining migration history to", version)
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := migration.CreateMigrationTable(ctx, conn); err != nil {
		return err
	}
	m, err := repair.NewMigrationFromVersion(version, fsys)
	if err != nil {
		return err
	}
	// Data statements don't mutate schemas, safe to use statement cache
	batch := pgx.Batch{}
	batch.Queue(migration.DELETE_MIGRATION_BEFORE, m.Version)
	batch.Queue(migration.INSERT_MIGRATION_VERSION, m.Version, m.Name, m.Statements)
	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to update migration history: %w", err)
	}
	return nil
}
