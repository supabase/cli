package diff

import (
	"bytes"
	"context"
	_ "embed"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
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
func DiffSchemaMigraBash(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
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

func DiffSchemaMigra(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	} else {
		env = append(env, "EXCLUDED_SCHEMAS="+strings.Join(managedSchemas, ","))
	}
	cmd := []string{"edge-runtime", "start", "--main-service=."}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")
	entrypoint := []string{"sh", "-c", `cat <<'EOF' > index.ts && ` + cmdString + `
` + diffSchemaTypeScript + `
EOF
`}
	var out, stderr bytes.Buffer
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image:      utils.Config.EdgeRuntime.Image,
			Env:        env,
			Entrypoint: entrypoint,
		},
		container.HostConfig{
			Binds:       []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"},
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		&out,
		&stderr,
	); err != nil && !strings.HasPrefix(stderr.String(), "main worker has been destroyed") {
		return "", errors.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
	}
	return out.String(), nil
}
