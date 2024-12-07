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

type DiffFunc func(context.Context, string, string, []string) (string, error)

func Run(ctx context.Context, schema []string, file string, config pgconn.Config, differ DiffFunc, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (err error) {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if utils.IsLocalDatabase(config) {
		if container, err := createShadowIfNotExists(ctx, fsys); err != nil {
			return err
		} else if len(container) > 0 {
			defer utils.DockerRemove(container)
			if err := start.WaitForHealthyService(ctx, start.HealthTimeout, container); err != nil {
				return err
			}
			if err := migrateBaseDatabase(ctx, container, fsys, options...); err != nil {
				return err
			}
		}
	}
	// 1. Load all user defined schemas
	if len(schema) == 0 {
		schema, err = loadSchema(ctx, config, options...)
		if err != nil {
			return err
		}
	}
	// 3. Run migra to diff schema
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

func createShadowIfNotExists(ctx context.Context, fsys afero.Fs) (string, error) {
	if exists, err := afero.DirExists(fsys, utils.SchemasDir); err != nil {
		return "", errors.Errorf("failed to check schemas: %w", err)
	} else if !exists {
		return "", nil
	}
	if err := utils.AssertSupabaseDbIsRunning(); !errors.Is(err, utils.ErrNotRunning) {
		return "", err
	}
	fmt.Fprintf(os.Stderr, "Creating local database from %s...\n", utils.Bold(utils.SchemasDir))
	return CreateShadowDatabase(ctx, utils.Config.Db.Port)
}

func loadDeclaredSchemas(fsys afero.Fs) ([]string, error) {
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

func loadSchema(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) ([]string, error) {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	// RLS policies in auth and storage schemas can be included with -s flag
	return migration.ListUserSchemas(ctx, conn)
}

func CreateShadowDatabase(ctx context.Context, port uint16) (string, error) {
	config := start.NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(port), 10)
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

func ConnectShadowDatabase(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) (conn *pgx.Conn, err error) {
	// Retry until connected, cancelled, or timeout
	policy := start.NewBackoffPolicy(ctx, timeout)
	config := pgconn.Config{Port: utils.Config.Db.ShadowPort}
	connect := func() (*pgx.Conn, error) {
		return utils.ConnectLocalPostgres(ctx, config, options...)
	}
	return backoff.RetryWithData(connect, policy)
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
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys); err != nil {
		return err
	}
	return migration.ApplyMigrations(ctx, migrations, conn, afero.NewIOFS(fsys))
}

func migrateBaseDatabase(ctx context.Context, container string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	migrations, err := loadDeclaredSchemas(fsys)
	if err != nil {
		return err
	}
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := start.SetupDatabase(ctx, conn, container[:12], os.Stderr, fsys); err != nil {
		return err
	}
	return migration.SeedGlobals(ctx, migrations, conn, afero.NewIOFS(fsys))
}

func DiffDatabase(ctx context.Context, schema []string, config pgconn.Config, w io.Writer, fsys afero.Fs, differ func(context.Context, string, string, []string) (string, error), options ...func(*pgx.ConnConfig)) (string, error) {
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
	fmt.Fprintln(w, "Diffing schemas:", strings.Join(schema, ","))
	source := utils.ToPostgresURL(pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	})
	target := utils.ToPostgresURL(config)
	return differ(ctx, source, target, schema)
}
