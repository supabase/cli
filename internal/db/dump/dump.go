package dump

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strings"

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

func Run(ctx context.Context, path, username, password, database, host string, dataOnly, roleOnly bool, fsys afero.Fs) error {
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
	if err := utils.DockerRunOnceWithStream(ctx, utils.Pg15Image, []string{
		"PGHOST=" + host,
		"PGUSER=" + username,
		"PGPASSWORD=" + password,
		"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
		"RESERVED_ROLES=" + strings.Join(utils.ReservedRoles, "|"),
		"DB_URL=" + database,
	}, []string{"bash", "-c", script}, nil, "", outStream, os.Stderr); err != nil {
		return errors.New("Error running pg_dump on remote database: " + err.Error())
	}
	if len(path) > 0 {
		fmt.Fprintln(os.Stderr, "Dumped schema to "+utils.Bold(path)+".")
	}
	return nil
}
