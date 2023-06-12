package dump

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
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
	var script string
	var excludedSchemas []string
	if dataOnly {
		fmt.Fprintln(os.Stderr, "Dumping data from remote database...")
		script = dumpDataScript
		// We want to dump user data in auth, storage, etc. for migrating to new project
		excludedSchemas = append([]string{
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
	} else if roleOnly {
		fmt.Fprintln(os.Stderr, "Dumping roles from remote database...")
		script = dumpRoleScript
	} else {
		fmt.Fprintln(os.Stderr, "Dumping schemas from remote database...")
		script = dumpSchemaScript
		excludedSchemas = utils.InternalSchemas
	}
	// Run script in docker
	cmd := []string{"bash", "-c", script, "--"}
	env := []string{}
	if !useCopy {
		env = append(env, "COLUMN_INSERTS=1")
	}
	if !keepComments {
		// Delete comments when arg1 is set
		cmd = append(cmd, "1")
	}
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Pg15Image,
			Env: append(env,
				"PGHOST="+config.Host,
				fmt.Sprintf("PGPORT=%d", config.Port),
				"PGUSER="+config.User,
				"PGPASSWORD="+config.Password,
				"EXCLUDED_SCHEMAS="+strings.Join(excludedSchemas, "|"),
				"RESERVED_ROLES="+strings.Join(utils.ReservedRoles, "|"),
				"ALLOWED_CONFIGS="+strings.Join(utils.AllowedConfigs, "|"),
				"DB_URL="+config.Database,
			),
			Cmd: cmd,
		},
		container.HostConfig{
			NetworkMode: container.NetworkMode("host"),
		},
		"",
		outStream,
		os.Stderr,
	); err != nil {
		return errors.New("Error running pg_dump on remote database: " + err.Error())
	}
	if len(path) > 0 {
		fmt.Fprintln(os.Stderr, "Dumped schema to "+utils.Bold(path)+".")
	}
	return nil
}
