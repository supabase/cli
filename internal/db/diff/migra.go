package diff

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

var (
	healthTimeout = 20 * time.Second
	//go:embed templates/migra.sh
	diffSchemaScript string
)

func RunMigra(ctx context.Context, schema []string, file string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (err error) {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if len(config.Password) > 0 {
		fmt.Fprintln(os.Stderr, "Connecting to remote database...")
	} else {
		fmt.Fprintln(os.Stderr, "Connecting to local database...")
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
		config.Host = "localhost"
		config.Port = uint16(utils.Config.Db.Port)
		config.User = "postgres"
		config.Password = "postgres"
		config.Database = "postgres"
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
	return SaveDiff(out, file, fsys)
}

func loadSchema(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (schema []string, err error) {
	var conn *pgx.Conn
	if config.Host == "localhost" && config.Port == uint16(utils.Config.Db.Port) {
		conn, err = utils.ConnectLocalPostgres(ctx, config, options...)
	} else {
		conn, err = utils.ConnectRemotePostgres(ctx, config, options...)
	}
	if err != nil {
		return schema, err
	}
	defer conn.Close(context.Background())
	return LoadUserSchemas(ctx, conn)
}

func LoadUserSchemas(ctx context.Context, conn *pgx.Conn, exclude ...string) ([]string, error) {
	if len(exclude) == 0 {
		// RLS policies in auth and storage schemas can be included with -s flag
		exclude = append([]string{
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
	}
	return reset.ListSchemas(ctx, conn, exclude...)
}

func CreateShadowDatabase(ctx context.Context) (string, error) {
	config := start.NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.ShadowPort), 10)
	hostConfig := container.HostConfig{
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		AutoRemove:   true,
	}
	if utils.Config.Db.MajorVersion <= 14 {
		config.Entrypoint = nil
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	return utils.DockerStart(ctx, config, hostConfig, "")
}

func connectShadowDatabase(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) (conn *pgx.Conn, err error) {
	now := time.Now()
	expiry := now.Add(timeout)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	// Retry until connected, cancelled, or timeout
	for t := now; t.Before(expiry); t = <-ticker.C {
		conn, err = utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: uint16(utils.Config.Db.ShadowPort)}, options...)
		if err == nil || errors.Is(ctx.Err(), context.Canceled) {
			break
		}
	}
	return conn, err
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
		"",
		&out,
		&stderr,
	); err != nil {
		return "", fmt.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
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
	if !reset.WaitForHealthyService(ctx, shadow, healthTimeout) {
		return "", reset.ErrDatabase
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	source := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/postgres", utils.Config.Db.ShadowPort)
	target := utils.ToPostgresURL(config)
	return DiffSchemaMigra(ctx, source, target, schema)
}
