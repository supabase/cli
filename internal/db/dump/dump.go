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

//go:embed templates/dump_schema.sh
var dumpSchemaScript string

func Run(ctx context.Context, path, username, password, database, host string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Dumping schemas from remote database...")
	out, err := utils.DockerRunOnce(ctx, utils.Pg15Image, []string{
		"PGHOST=" + host,
		"PGUSER=" + username,
		"PGPASSWORD=" + password,
		"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
		"DB_URL=" + database,
	}, []string{"bash", "-c", dumpSchemaScript})
	if err != nil {
		return errors.New("Error running pg_dump on remote database: " + err.Error())
	}

	if len(path) > 0 {
		if err := afero.WriteFile(fsys, path, []byte(out), 0644); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "Dumped schema to "+utils.Bold(path)+".")
	} else {
		fmt.Println(out)
	}

	return nil
}
