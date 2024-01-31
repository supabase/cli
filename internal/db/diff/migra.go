package diff

import (
	"bytes"
	"context"
	_ "embed"
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
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

//go:embed templates/migra.sh
var diffSchemaScript string

func RunMigra(ctx context.Context, schema []string, file string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (err error) {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// 1. Load all user defined schemas
	if len(schema) == 0 {
		schema, err = loadSchema(ctx, config, options...)
		if err != nil {
			return err
		}
	}
	// 3. Run migra to diff schema
	out, err := DiffDatabase(ctx, schema, config, os.Stderr, fsys, options...)
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

func loadSchema(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) ([]string, error) {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return LoadUserSchemas(ctx, conn)
}

func LoadUserSchemas(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	// RLS policies in auth and storage schemas can be included with -s flag
	exclude := append([]string{
		"auth",
		// "extensions",
		"pgbouncer",
		"realtime",
		"_realtime",
		"storage",
		"_analytics",
		// Exclude functions because Webhooks support is early alpha
		"supabase_functions",
		"supabase_migrations",
	}, utils.SystemSchemas...)
	return reset.ListSchemas(ctx, conn, exclude...)
}

func CreateShadowDatabase(ctx context.Context) (string, error) {
	config := start.NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.ShadowPort), 10)
	hostConfig := container.HostConfig{
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		AutoRemove:   true,
	}
	networkingConfig := network.NetworkingConfig{}
	if utils.Config.Db.MajorVersion <= 14 {
		config.Entrypoint = nil
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	return utils.DockerStart(ctx, config, hostConfig, networkingConfig, "")
}

func connectShadowDatabase(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) (conn *pgx.Conn, err error) {
	// Retry until connected, cancelled, or timeout
	policy := backoff.WithMaxRetries(backoff.NewConstantBackOff(time.Second), uint64(timeout.Seconds()))
	config := pgconn.Config{Port: uint16(utils.Config.Db.ShadowPort)}
	connect := func() (*pgx.Conn, error) {
		return utils.ConnectLocalPostgres(ctx, config, options...)
	}
	return backoff.RetryWithData(connect, backoff.WithContext(policy, ctx))
}

func MigrateShadowDatabase(ctx context.Context, container string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	migrations, err := list.LoadLocalMigrations(fsys)
	if err != nil {
		return err
	}
	return MigrateShadowDatabaseVersions(ctx, container, migrations, fsys, options...)
}

func MigrateShadowDatabaseVersions(ctx context.Context, container string, migrations []string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := connectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys); err != nil {
		return err
	}
	return apply.MigrateUp(ctx, conn, migrations, fsys)
}

// Diffs local database schema against shadow, dumps output to stdout.
func DiffSchemaMigra(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	var out, stderr bytes.Buffer
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.MigraImage,
			Env:   env,
			Cmd:   cmd,
		},
		container.HostConfig{
			NetworkMode: container.NetworkMode("host"),
		},
		network.NetworkingConfig{},
		"",
		&out,
		&stderr,
	); err != nil {
		return "", errors.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
	}
	return out.String(), nil
}

func DiffDatabase(ctx context.Context, schema []string, config pgconn.Config, w io.Writer, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	fmt.Fprintln(w, "Creating shadow database...")
	shadow, err := CreateShadowDatabase(ctx)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	if !start.WaitForHealthyService(ctx, shadow, start.HealthTimeout) {
		return "", errors.New(start.ErrDatabase)
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	source := utils.ToPostgresURL(pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     uint16(utils.Config.Db.ShadowPort),
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	})
	target := utils.ToPostgresURL(config)
	return DiffSchemaMigra(ctx, source, target, schema)
}
