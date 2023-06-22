package dump

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
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

func Run(ctx context.Context, path string, config pgconn.Config, dataOnly, roleOnly, keepComments, useCopy bool, fsys afero.Fs) error {
	// Initialise output stream
	var outStream afero.File
	if len(path) > 0 {
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		defer f.Close()
		outStream = f
	} else {
		outStream = os.Stdout
	}
	// Load the requested script
	if dataOnly {
		fmt.Fprintln(os.Stderr, "Dumping data from remote database...")
		return dumpData(ctx, config, useCopy, outStream)
	} else if roleOnly {
		fmt.Fprintln(os.Stderr, "Dumping roles from remote database...")
		return dumpRole(ctx, config, keepComments, outStream)
	}
	fmt.Fprintln(os.Stderr, "Dumping schemas from remote database...")
	return DumpSchema(ctx, config, keepComments, outStream)
}

func DumpSchema(ctx context.Context, config pgconn.Config, keepComments bool, stdout io.Writer) error {
	env := []string{"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|")}
	if !keepComments {
		env = append(env, "DELETE_COMMENTS=1")
	}
	return dump(ctx, config, dumpSchemaScript, env, stdout)
}

func dumpData(ctx context.Context, config pgconn.Config, useCopy bool, stdout io.Writer) error {
	// We want to dump user data in auth, storage, etc. for migrating to new project
	excludedSchemas := append([]string{
		// "auth",
		"extensions",
		"pgbouncer",
		"realtime",
		"_realtime",
		// "storage",
		"_analytics",
		// "supabase_functions",
		"supabase_migrations",
	}, utils.SystemSchemas...)
	env := []string{"EXCLUDED_SCHEMAS=" + strings.Join(excludedSchemas, "|")}
	if !useCopy {
		env = append(env, "COLUMN_INSERTS=1")
	}
	return dump(ctx, config, dumpDataScript, env, stdout)
}

func dumpRole(ctx context.Context, config pgconn.Config, keepComments bool, stdout io.Writer) error {
	env := []string{}
	if !keepComments {
		env = append(env, "DELETE_COMMENTS=1")
	}
	return dump(ctx, config, dumpRoleScript, env, stdout)
}

func dump(ctx context.Context, config pgconn.Config, script string, env []string, stdout io.Writer) error {
	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Pg15Image,
			Env: append(env,
				"PGHOST="+config.Host,
				fmt.Sprintf("PGPORT=%d", config.Port),
				"PGUSER="+config.User,
				"PGPASSWORD="+config.Password,
				"RESERVED_ROLES="+strings.Join(utils.ReservedRoles, "|"),
				"ALLOWED_CONFIGS="+strings.Join(utils.AllowedConfigs, "|"),
				"DB_URL="+config.Database,
			),
			Cmd: []string{"bash", "-c", script, "--"},
		},
		container.HostConfig{
			NetworkMode: container.NetworkMode("host"),
		},
		"",
		stdout,
		os.Stderr,
	)
}
