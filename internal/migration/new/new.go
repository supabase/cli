package new

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pkg/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(name string, reader io.Reader, fs afero.Fs) error {
	timestamp := time.Now().UTC().Format("20060102150405")
	filename := fmt.Sprintf("%s_%s.sql", timestamp, name)
	path := fmt.Sprintf("supabase/migrations/%s", filename)

	content, err := io.ReadAll(reader)
	if err != nil {
		return err
	}

	err = afero.WriteFile(fs, path, content, 0644)
	if err != nil {
		return fmt.Errorf("failed to create migration: %w", err)
	}

	fmt.Printf("Created new migration at %s\n", path)
	return nil
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
