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

const (
	TemplatePgTAP = "pgtap"
)

var (
	//go:embed templates/pgtap.sql
	pgtapTest []byte
)

func Run(ctx context.Context, name, template string, fsys afero.Fs) error {
	path := filepath.Join(utils.DbTestsDir, fmt.Sprintf("%s_test.sql", name))
	if _, err := fsys.Stat(path); err == nil {
		return errors.New(path + " already exists.")
	}
	if err := utils.WriteFile(path, getTemplate(template), fsys); err != nil {
		return err
	}
	fmt.Printf("Created new %s test at %s.\n", template, utils.Bold(path))
	return nil
}

func getTemplate(name string) []byte {
	switch name {
	case TemplatePgTAP:
		return pgtapTest
	}
	return nil
}
