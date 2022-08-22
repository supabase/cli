package new

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string, stdin afero.File, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}

	path := GetMigrationPath(migrationName)
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if fi, err := stdin.Stat(); err != nil {
		return err
	} else if (fi.Mode() & os.ModeCharDevice) == 0 {
		// Ref: https://stackoverflow.com/a/26567513
		if _, err := io.Copy(f, stdin); err != nil {
			return err
		}
	}

	fmt.Println("Created new migration at " + utils.Bold(path) + ".")
	return nil
}

func GetMigrationPath(migrationName string) string {
	name := utils.GetCurrentTimestamp() + "_" + migrationName + ".sql"
	return filepath.Join(utils.MigrationsDir, name)
}
