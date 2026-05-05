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
	if types.IsSSLDebugEnabled() {
		env = append(env, "SUPABASE_SSL_DEBUG=true")
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
	debugf := func(string, ...any) {}
	if types.IsSSLDebugEnabled() {
		debugf = types.LogSSLDebugf
		env = append(env, "SUPABASE_SSL_DEBUG=true")
		debugf("DiffSchemaMigra source_host=%s source_port=%d target_host=%s target_port=%d target_db=%s",
			source.Host,
			source.Port,
			target.Host,
			target.Port,
			target.Database,
		)
		debugf("DiffSchemaMigra docker_daemon=%s image=%s", utils.Docker.DaemonHost(), utils.Config.EdgeRuntime.Image)
	}
	if ca, err := types.GetRootCA(ctx, utils.ToPostgresURL(target), options...); err != nil {
		debugf("DiffSchemaMigra GetRootCA error=%v", err)
		return "", err
	} else if len(ca) > 0 {
		env = append(env, "SSL_CA="+ca)
		debugf("DiffSchemaMigra GetRootCA ca_bundle_len=%d", len(ca))
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	} else {
		env = append(env, "EXCLUDED_SCHEMAS="+strings.Join(managedSchemas, ","))
	}
	// Migra also executes via Edge Runtime because the TypeScript implementation
	// shares the same containerized execution environment as other diff engines.
	// The helper remains in package diff to avoid coupling migra code paths to
	// pg-delta-specific packages.
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, diffSchemaTypeScript, binds, "error diffing schema", &stdout, &stderr); err != nil {
		if shouldFallbackToLegacyMigra(err) {
			debugf("DiffSchemaMigra falling back to legacy migra after edge-runtime OOM")
			return DiffSchemaMigraBash(ctx, source, target, schema, options...)
		}
		return "", err
	}
	return stdout.String(), nil
}

func shouldFallbackToLegacyMigra(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Fatal JavaScript out of memory") ||
		strings.Contains(message, "Ineffective mark-compacts near heap limit")
}
