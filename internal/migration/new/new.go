package new

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string, stdin io.Reader, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}

	name := utils.GetCurrentTimestamp() + "_" + migrationName + ".sql"
	path := filepath.Join(utils.MigrationsDir, name)
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, stdin); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	fmt.Println("Created new migration at " + utils.Bold(path) + ".")
	return nil
}
