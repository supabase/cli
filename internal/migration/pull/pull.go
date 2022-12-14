package pull

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/dump_initial_migration.sh
var dumpInitialMigrationScript string

func Run(ctx context.Context, username, password, database, host string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Pulling schemas from remote database...")
	out, err := utils.DockerRunOnce(ctx, utils.Pg14Image, []string{
		"PGHOST=" + host,
		"PGUSER=" + username,
		"PGPASSWORD=" + password,
		"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
		"DB_URL=" + database,
	}, []string{"bash", "-c", dumpInitialMigrationScript})
	if err != nil {
		return errors.New("Error running pg_dump on remote database: " + err.Error())
	}

	path := new.GetMigrationPath("remote_commit")
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, path, []byte(out), 0644); err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Created new migration at "+utils.Bold(path)+".")
	fmt.Println("Finished " + utils.Aqua("supabase migration pull") + ".")
	return nil
}
