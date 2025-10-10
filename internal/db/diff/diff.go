package diff

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
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
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/parser"
)

type DiffFunc func(context.Context, pgconn.Config, pgconn.Config, []string, ...func(*pgx.ConnConfig)) (string, error)

func Run(ctx context.Context, schema []string, file string, config pgconn.Config, differ DiffFunc, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (err error) {
	out, err := DiffDatabase(ctx, schema, config, os.Stderr, fsys, differ, options...)
	if err != nil {
		return err
	}
	branch := keys.GetGitBranch(fsys)
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db diff")+" on branch "+utils.Aqua(branch)+".\n")
	if err := SaveDiff(out, file, fsys); err != nil {
		return err
	}
	drops := findDropStatements(out)
	if len(drops) > 0 {
		fmt.Fprintln(os.Stderr, "Found drop statements in schema diff. Please double check if these are expected:")
		fmt.Fprintln(os.Stderr, utils.Yellow(strings.Join(drops, "\n")))
	}
	return nil
}

func loadDeclaredSchemas(fsys afero.Fs) ([]string, error) {
	if schemas := utils.Config.Db.Migrations.SchemaPaths; len(schemas) > 0 {
		return schemas.Files(afero.NewIOFS(fsys))
	}
	if exists, err := afero.DirExists(fsys, utils.SchemasDir); err != nil {
		return nil, errors.Errorf("failed to check schemas: %w", err)
	} else if !exists {
		return nil, nil
	}
	var declared []string
	if err := afero.Walk(fsys, utils.SchemasDir, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && filepath.Ext(info.Name()) == ".sql" {
			declared = append(declared, path)
		}
		return nil
	}); err != nil {
		return nil, errors.Errorf("failed to walk dir: %w", err)
	}
	return declared, nil
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
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, CREATE_TEMPLATE); err != nil {
		return errors.Errorf("failed to create template database: %w", err)
	}
	// Migrations take precedence over declarative schemas
	if len(migrations) > 0 {
		return migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys))
	}
	declared, err := loadDeclaredSchemas(fsys)
	if err != nil || len(declared) == 0 {
		return err
	}
	fmt.Fprintln(os.Stderr, "Creating local database from declarative schemas:")
	msg := make([]string, len(declared))
	for i, m := range declared {
		msg[i] = fmt.Sprintf(" • %s", utils.Bold(m))
	}
	fmt.Fprintln(os.Stderr, strings.Join(msg, "\n"))
	return migration.SeedGlobals(ctx, declared, conn, afero.NewIOFS(fsys))
}

func DiffDatabase(ctx context.Context, schema []string, config pgconn.Config, w io.Writer, fsys afero.Fs, differ DiffFunc, options ...func(*pgx.ConnConfig)) (string, error) {
	fmt.Fprintln(w, "Creating shadow database...")
	shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, shadow); err != nil {
		return "", err
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	if utils.IsLocalDatabase(config) {
		if declared, err := loadDeclaredSchemas(fsys); err != nil {
			return "", err
		} else if len(declared) > 0 {
			config = shadowConfig
			config.Database = "contrib_regression"
			if err := migrateBaseDatabase(ctx, config, declared, fsys, options...); err != nil {
				return "", err
			}
		}
	}
	// Load all user defined schemas
	if len(schema) > 0 {
		fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	} else {
		fmt.Fprintln(w, "Diffing schemas...")
	}
	return differ(ctx, shadowConfig, config, schema, options...)
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
