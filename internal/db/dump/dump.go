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

func Run(ctx context.Context, path string, config pgconn.Config, dataOnly, roleOnly bool, fsys afero.Fs) error {
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
	if dataOnly {
		fmt.Fprintln(os.Stderr, "Dumping data from remote database...")
		script = dumpDataScript
	} else if roleOnly {
		fmt.Fprintln(os.Stderr, "Dumping roles from remote database...")
		script = dumpRoleScript
	} else {
		fmt.Fprintln(os.Stderr, "Dumping schemas from remote database...")
		script = dumpSchemaScript
	}
	// Run script in docker
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Pg15Image,
			Env: []string{
				"PGHOST=" + config.Host,
				"PGUSER=" + config.User,
				"PGPASSWORD=" + config.Password,
				"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
				"RESERVED_ROLES=" + strings.Join(utils.ReservedRoles, "|"),
				"DB_URL=" + config.Database,
			},
			Cmd: []string{"bash", "-c", script},
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
