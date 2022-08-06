package new

import (
	"fmt"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}

	name := utils.GetCurrentTimestamp() + "_" + migrationName + ".sql"
	path := filepath.Join(utils.MigrationsDir, name)
	if err := afero.WriteFile(fsys, path, []byte{}, 0644); err != nil {
		return err
	}

	fmt.Println("Created new migration at " + utils.Bold(path) + ".")
	return nil
}
