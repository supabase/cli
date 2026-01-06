package diff

import (
	"bytes"
	"context"
	_ "embed"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/migration"
)

var (
	//go:embed templates/migra.sh
	diffSchemaScript string
	//go:embed templates/migra.ts
	diffSchemaTypeScript string

	managedSchemas = []string{
		// Local development
		"_analytics",
		"_realtime",
		"_supavisor",
		// Owned by extensions
		"cron",
		"graphql",
		"graphql_public",
		"net",
		"pgroonga",
		"pgtle",
		"repack",
		"tiger_data",
		"vault",
		// Deprecated extensions
		"pgsodium",
		"pgsodium_masks",
		"timescaledb_experimental",
		"timescaledb_information",
		"_timescaledb_cache",
		"_timescaledb_catalog",
		"_timescaledb_config",
		"_timescaledb_debug",
		"_timescaledb_functions",
		"_timescaledb_internal",
		// Managed by Supabase
		"pgbouncer",
		"supabase_functions",
		"supabase_migrations",
	}
)

// Diffs local database schema against shadow, dumps output to stdout.
func DiffSchemaMigraBash(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	// Load all user defined schemas
	if len(schema) == 0 {
		var err error
		if schema, err = loadSchema(ctx, target, options...); err != nil {
			return "", err
		}
	}
	env := []string{
		"SOURCE=" + utils.ToPostgresURL(source),
		"TARGET=" + utils.ToPostgresURL(target),
	}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	var out, stderr bytes.Buffer
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: config.Images.Migra,
			Env:   env,
			Cmd:   cmd,
		},
		container.HostConfig{
			NetworkMode: network.NetworkHost,
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

func loadSchema(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) ([]string, error) {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	// RLS policies in auth and storage schemas can be included with -s flag
	return migration.ListUserSchemas(ctx, conn)
}

func DiffSchemaMigra(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"SOURCE=" + utils.ToPostgresURL(source),
		"TARGET=" + utils.ToPostgresURL(target),
	}
	if ca, err := types.GetRootCA(ctx, utils.ToPostgresURL(target), options...); err != nil {
		return "", err
	} else if len(ca) > 0 {
		env = append(env, "SSL_CA="+ca)
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	} else {
		env = append(env, "EXCLUDED_SCHEMAS="+strings.Join(managedSchemas, ","))
	}
	var out bytes.Buffer
	if err := diffWithStream(ctx, env, diffSchemaTypeScript, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}
