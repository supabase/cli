package diff

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/parser"
)

type DiffFunc func(context.Context, pgconn.Config, pgconn.Config, []string, ...func(*pgx.ConnConfig)) (string, error)

const schemaPathsTransitionWarning = "WARNING: [db.migrations].schema_paths no longer changes the target of db diff or migration-style db pull. These commands always compare local migrations with the selected database. Use `supabase db schema declarative sync` to compare declarative schema files."

func Run(ctx context.Context, schema []string, file string, config pgconn.Config, differ DiffFunc, usePgDelta bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (err error) {
	result, err := DiffDatabase(ctx, schema, config, os.Stderr, fsys, differ, usePgDelta, options...)
	if err != nil {
		return err
	}
	out := result.SQL
	branch := utils.GetGitBranch(fsys)
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db diff")+" on branch "+utils.Aqua(branch)+".\n")
	if err := SaveDiff(result, file, fsys); err != nil {
		return err
	}
	drops := findDropStatements(out)
	if len(drops) > 0 {
		fmt.Fprintln(os.Stderr, "Found drop statements in schema diff. Please double check if these are expected:")
		fmt.Fprintln(os.Stderr, utils.Yellow(strings.Join(drops, "\n")))
	}
	return nil
}

// https://github.com/djrobstep/migra/blob/master/migra/statements.py#L6
var dropStatementPattern = regexp.MustCompile(`(?i)drop\s+`)

func findDropStatements(out string) []string {
	lines, err := parser.SplitAndTrim(strings.NewReader(out))
	if err != nil {
		return nil
	}
	var drops []string
	for _, line := range lines {
		if dropStatementPattern.MatchString(line) {
			drops = append(drops, line)
		}
	}
	return drops
}

func CreateShadowDatabase(ctx context.Context, port uint16) (string, error) {
	// Disable background workers in shadow database
	config := start.NewContainerConfig("-c", "max_worker_processes=0")
	hostPort := strconv.FormatUint(uint64(port), 10)
	hostConfig := container.HostConfig{
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		AutoRemove:   true,
	}
	networkingConfig := network.NetworkingConfig{}
	if utils.Config.Db.MajorVersion <= 14 {
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	return utils.DockerStart(ctx, config, hostConfig, networkingConfig, "")
}

func ConnectShadowDatabase(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) (conn *pgx.Conn, err error) {
	// Retry until connected, cancelled, or timeout
	policy := start.NewBackoffPolicy(ctx, timeout)
	config := pgconn.Config{Port: utils.Config.Db.ShadowPort}
	connect := func() (*pgx.Conn, error) {
		return utils.ConnectLocalPostgres(ctx, config, options...)
	}
	return backoff.RetryWithData(connect, policy)
}

// Required to bypass pg_cron check: https://github.com/citusdata/pg_cron/blob/main/pg_cron.sql#L3
const CREATE_TEMPLATE = "CREATE DATABASE contrib_regression TEMPLATE postgres"

// setupShadowConn applies the Supabase platform schema (auth, storage, realtime,
// etc.) to an already-connected shadow database and creates the pg_cron template
// database. It deliberately stops short of applying user migrations so that
// callers which only need the platform baseline (declarative apply) share the
// exact same starting point as callers that also replay migrations.
func setupShadowConn(ctx context.Context, conn *pgx.Conn, container string, fsys afero.Fs) error {
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, CREATE_TEMPLATE); err != nil {
		return errors.Errorf("failed to create template database: %w", err)
	}
	return nil
}

// SetupShadowDatabase provisions the Supabase platform baseline (service schemas
// such as auth/storage/realtime) on a freshly created shadow database, without
// applying user migrations. Declarative apply uses this so the shadow matches the
// real database closely enough for Supabase-managed dependencies (auth.sessions,
// auth.jwt(), ...) to resolve.
func SetupShadowDatabase(ctx context.Context, container string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := ConnectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return setupShadowConn(ctx, conn, container, fsys)
}

var pgDeltaNextDeclarativeExtensionDrops = []struct {
	name string
	sql  string
}{
	{name: "pgcrypto", sql: "DROP EXTENSION IF EXISTS pgcrypto"},
	{name: "uuid-ossp", sql: `DROP EXTENSION IF EXISTS "uuid-ossp"`},
}

// SetupPgDeltaNextDeclarativeShadowDatabase provisions cluster B with the
// platform baseline but without activating user-managed extensions. Those
// extensions must come exclusively from declarative SQL so deleting their files
// can produce DROP EXTENSION plans.
func SetupPgDeltaNextDeclarativeShadowDatabase(ctx context.Context, container string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if utils.Config.Db.MajorVersion != 17 {
		return errors.Errorf(
			"pg-delta declarative shadow baseline requires Postgres 17 (got major %d, image %q)",
			utils.Config.Db.MajorVersion,
			utils.Config.Db.Image,
		)
	}
	conn, err := ConnectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys, start.WithoutUserExtensionActivation()); err != nil {
		return err
	}
	for _, extension := range pgDeltaNextDeclarativeExtensionDrops {
		if _, err := conn.Exec(ctx, extension.sql); err != nil {
			return errors.Errorf(
				"failed to remove user-managed extension %q from pg-delta declarative shadow baseline (image %q): %w",
				extension.name,
				utils.Config.Db.Image,
				err,
			)
		}
	}
	return nil
}

func MigrateShadowDatabase(ctx context.Context, container string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return err
	}
	conn, err := ConnectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := setupShadowConn(ctx, conn, container, fsys); err != nil {
		return err
	}
	return migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys))
}

func DiffDatabase(ctx context.Context, schema []string, config pgconn.Config, w io.Writer, fsys afero.Fs, differ DiffFunc, usePgDelta bool, options ...func(*pgx.ConnConfig)) (DatabaseDiff, error) {
	if len(utils.Config.Db.Migrations.SchemaPaths) > 0 {
		fmt.Fprintln(w, schemaPathsTransitionWarning)
	}
	fmt.Fprintln(w, "Creating shadow database...")
	shadowSource, err := PrepareShadowSource(ctx, fsys, options...)
	if err != nil {
		return DatabaseDiff{}, err
	}
	defer utils.DockerRemove(shadowSource.Container)
	shadowConfig := shadowSource.Source
	// Load all user defined schemas
	if len(schema) > 0 {
		fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	} else {
		fmt.Fprintln(w, "Diffing schemas...")
	}
	if usePgDelta {
		// pg-delta always goes through the diffPgDeltaRefDetailed seam so callers get
		// the execution-aware per-unit files (db pull writes one migration file each);
		// db diff/declarative flatten them back via SQL. This mirrors the config-based
		// differ (DiffPgDelta) exactly, so it is safe to bypass the injected differ()
		// here — differ() remains the migra engine path below.
		var debugCapture *PgDeltaDebugCapture
		if IsPgDeltaDebugEnabled() {
			// Capture the shadow baseline catalog and edge-runtime stderr so an
			// empty diff can be inspected later.
			debugCapture = &PgDeltaDebugCapture{}
			if snapshot, exportErr := exportCatalogPgDelta(ctx, utils.ToPostgresURL(shadowConfig), "postgres", options...); exportErr == nil {
				debugCapture.SourceCatalog = snapshot
			} else {
				fmt.Fprintf(w, "Warning: failed to export shadow pg-delta catalog: %v\n", exportErr)
			}
		}
		result, err := diffPgDeltaRefDetailed(ctx, utils.ToPostgresURL(shadowConfig), utils.ToPostgresURL(config), schema, pgDeltaFormatOptions(), options...)
		if err != nil {
			return DatabaseDiff{}, err
		}
		if debugCapture != nil {
			debugCapture.Stderr = result.Stderr
		}
		return DatabaseDiff{SQL: joinPgDeltaFiles(result.Files), Files: result.Files, Debug: debugCapture}, nil
	}
	output, err := differ(ctx, shadowConfig, config, schema, options...)
	if err != nil {
		return DatabaseDiff{}, err
	}
	return DatabaseDiff{SQL: output}, nil
}

func migrateBaseDatabase(ctx context.Context, config pgconn.Config, migrations []string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Creating local database from declarative schemas:")
	msg := make([]string, len(migrations))
	for i, m := range migrations {
		msg[i] = fmt.Sprintf(" • %s", utils.Bold(m))
	}
	fmt.Fprintln(os.Stderr, strings.Join(msg, "\n"))
	conn, err := utils.ConnectLocalPostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return migration.SeedGlobals(ctx, migrations, conn, afero.NewIOFS(fsys))
}
