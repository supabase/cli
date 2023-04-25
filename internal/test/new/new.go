package new

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/pgtap.sql
	pgtapTest []byte
)

func Run(ctx context.Context, name string, fsys afero.Fs) error {
	path := filepath.Join(utils.DbTestsDir, fmt.Sprintf("%s_test.sql", name))
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	if _, err := fsys.Stat(path); err == nil {
		return errors.New(path + " already exists.")
	}
	err := afero.WriteFile(fsys, path, pgtapTest, 0644)
	if err == nil {
		fmt.Println("Created new pgTAP test at " + utils.Bold(path) + ".")
	}
	return err
}
