package dump

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/dump_schema.sh
	dumpSchemaScript string
	//go:embed templates/dump_data.sh
	dumpDataScript string
	//go:embed templates/dump_role.sh
	dumpRoleScript string
)

func Run(ctx context.Context, path string, config pgconn.Config, schema, excludeTable []string, dataOnly, roleOnly, keepComments, useCopy, dryRun bool, fsys afero.Fs) error {
	// Initialize output stream
	var outStream afero.File
	if len(path) > 0 {
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return errors.Errorf("failed to open dump file: %w", err)
		}
		defer f.Close()
		outStream = f
	} else {
		outStream = os.Stdout
	}
	// Load the requested script
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: *only* printing the pg_dump script to console.")
	}
	if dataOnly {
		fmt.Fprintln(os.Stderr, "Dumping data from remote database...")
		return dumpData(ctx, config, schema, excludeTable, useCopy, dryRun, outStream)
	} else if roleOnly {
		fmt.Fprintln(os.Stderr, "Dumping roles from remote database...")
		return dumpRole(ctx, config, keepComments, dryRun, outStream)
	}
	fmt.Fprintln(os.Stderr, "Dumping schemas from remote database...")
	return DumpSchema(ctx, config, schema, keepComments, dryRun, outStream)
}

func DumpSchema(ctx context.Context, config pgconn.Config, schema []string, keepComments, dryRun bool, stdout io.Writer) error {
	var env []string
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, "|"))
	} else {
		env = append(env,
			"EXCLUDED_SCHEMAS="+strings.Join(utils.InternalSchemas, "|"),
			"INCLUDED_SCHEMAS=*",
		)
	}
	if !keepComments {
		env = append(env, "EXTRA_SED=/^--/d")
	}
	return dump(ctx, config, dumpSchemaScript, env, dryRun, stdout)
}

func dumpData(ctx context.Context, config pgconn.Config, schema, excludeTable []string, useCopy, dryRun bool, stdout io.Writer) error {
	// We want to dump user data in auth, storage, etc. for migrating to new project
	excludedSchemas := []string{
		"information_schema",
		"pg_*", // Wildcard pattern follows pg_dump
		// Owned by extensions
		// "cron",
		"graphql",
		"graphql_public",
		// "net",
		// "pgsodium",
		// "pgsodium_masks",
		"pgtle",
		"repack",
		"tiger",
		"tiger_data",
		"timescaledb_*",
		"_timescaledb_*",
		"topology",
		// "vault",
		// Managed by Supabase
		// "auth",
		"extensions",
		"pgbouncer",
		"realtime",
		"_realtime",
		// "storage",
		"_analytics",
		// "supabase_functions",
		"supabase_migrations",
	}
	var env []string
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, "|"))
	} else {
		env = append(env, "INCLUDED_SCHEMAS=*", "EXCLUDED_SCHEMAS="+strings.Join(excludedSchemas, "|"))
	}
	var extraFlags []string
	if !useCopy {
		extraFlags = append(extraFlags, "--column-inserts", "--rows-per-insert 100000")
	}
	for _, table := range excludeTable {
		extraFlags = append(extraFlags, "--exclude-table "+table)
	}
	if len(extraFlags) > 0 {
		env = append(env, "EXTRA_FLAGS="+strings.Join(extraFlags, " "))
	}
	return dump(ctx, config, dumpDataScript, env, dryRun, stdout)
}

func dumpRole(ctx context.Context, config pgconn.Config, keepComments, dryRun bool, stdout io.Writer) error {
	env := []string{}
	if !keepComments {
		env = append(env, "EXTRA_SED=/^--/d")
	}
	return dump(ctx, config, dumpRoleScript, env, dryRun, stdout)
}

func dump(ctx context.Context, config pgconn.Config, script string, env []string, dryRun bool, stdout io.Writer) error {
	allEnvs := append(env,
		"PGHOST="+config.Host,
		fmt.Sprintf("PGPORT=%d", config.Port),
		"PGUSER="+config.User,
		"PGPASSWORD="+config.Password,
		"PGDATABASE="+config.Database,
		"RESERVED_ROLES="+strings.Join(utils.ReservedRoles, "|"),
		"ALLOWED_CONFIGS="+strings.Join(utils.AllowedConfigs, "|"),
	)
	if dryRun {
		envMap := make(map[string]string, len(allEnvs))
		for _, e := range allEnvs {
			index := strings.IndexByte(e, '=')
			if index < 0 {
				continue
			}
			envMap[e[:index]] = e[index+1:]
		}
		expanded := os.Expand(script, func(key string) string {
			// Bash variable expansion is unsupported:
			// https://github.com/golang/go/issues/47187
			parts := strings.Split(key, ":")
			return envMap[parts[0]]
		})
		fmt.Println(expanded)
		return nil
	}
	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Pg15Image,
			Env:   allEnvs,
			Cmd:   []string{"bash", "-c", script, "--"},
		},
		container.HostConfig{
			NetworkMode: container.NetworkMode("host"),
		},
		network.NetworkingConfig{},
		"",
		stdout,
		os.Stderr,
	)
}
