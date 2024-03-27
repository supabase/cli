package new

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string, stdin afero.File, fsys afero.Fs) error {
	path := GetMigrationPath(utils.GetCurrentTimestamp(), migrationName)
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open migration file: %w", err)
	}
	defer func() {
		fmt.Println("Created new migration at " + utils.Bold(path))
		// File descriptor will always be closed when process quits
		_ = f.Close()
	}()
	return CopyStdinIfExists(stdin, f)
}

func GetMigrationPath(timestamp, name string) string {
	fullName := fmt.Sprintf("%s_%s.sql", timestamp, name)
	return filepath.Join(utils.MigrationsDir, fullName)
}

func CopyStdinIfExists(stdin afero.File, dst io.Writer) error {
	if fi, err := stdin.Stat(); err != nil {
		return errors.Errorf("failed to initialise stdin: %w", err)
	} else if (fi.Mode() & os.ModeCharDevice) == 0 {
		// Ref: https://stackoverflow.com/a/26567513
		if _, err := io.Copy(dst, stdin); err != nil {
			return errors.Errorf("failed to copy from stdin: %w", err)
		}
	}
	return nil
}
