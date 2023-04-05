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
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/utils"
)

const LIST_SCHEMAS = "SELECT schema_name FROM information_schema.schemata WHERE NOT schema_name LIKE ANY($1) ORDER BY schema_name"

var (
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
	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		branch = "main"
	}
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db diff")+" on branch "+utils.Aqua(branch)+".\n")
	return SaveDiff(out, file, fsys)
}

func loadSchema(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (schema []string, err error) {
	var conn *pgx.Conn
	if config.Host == "localhost" && config.Port == uint16(utils.Config.Db.Port) {
		conn, err = utils.ConnectLocalPostgres(ctx, config.Host, uint(config.Port), config.Database, options...)
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
	// Include auth,storage,extensions by default for RLS policies
	if len(exclude) == 0 {
		exclude = append([]string{
			"_analytics",
			"pgbouncer",
			"realtime",
			"_realtime",
			// Exclude functions because Webhooks support is early alpha
			"supabase_functions",
			"supabase_migrations",
		}, utils.SystemSchemas...)
		exclude = likeEscapeSchema(exclude)
	}
	rows, err := conn.Query(ctx, LIST_SCHEMAS, exclude)
	if err != nil {
		return nil, err
	}
	schemas := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		schemas = append(schemas, name)
	}
	return schemas, nil
}

func likeEscapeSchema(schemas []string) (result []string) {
	// Treat _ as literal, * as any character
	replacer := strings.NewReplacer("_", `\_`, "*", "%")
	for _, sch := range schemas {
		result = append(result, replacer.Replace(sch))
	}
	return result
}

func CreateShadowDatabase(ctx context.Context) (string, error) {
	config := start.NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.ShadowPort), 10)
	hostConfig := container.HostConfig{
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		Tmpfs:        map[string]string{"/docker-entrypoint-initdb.d": ""},
		AutoRemove:   true,
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
		conn, err = utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.ShadowPort, "postgres", options...)
		if err == nil || errors.Is(ctx.Err(), context.Canceled) {
			break
		}
	}
	return conn, err
}

func MigrateShadowDatabase(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := connectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}
	if roles, err := fsys.Open(utils.CustomRolesPath); err == nil {
		if err := apply.BatchExecDDL(ctx, conn, roles); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql)); err != nil {
		return err
	}
	return apply.MigrateDatabase(ctx, conn, fsys)
}

// Applies local migration scripts to a database.
func ApplyMigrations(ctx context.Context, url string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return apply.MigrateDatabase(ctx, conn, fsys)
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
	if err := MigrateShadowDatabase(ctx, fsys, options...); err != nil {
		return "", err
	}
	fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	source := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/postgres", utils.Config.Db.ShadowPort)
	target := utils.ToPostgresURL(config)
	return DiffSchemaMigra(ctx, source, target, schema)
}
