package new

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/index.ts
	index string
)

func Run(ctx context.Context, slug string, fsys afero.Fs) error {
	// 1. Sanity checks.
	funcDir := "supabase/functions/" + slug
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
		if _, err := fsys.Stat(funcDir); !errors.Is(err, os.ErrNotExist) {
			return errors.New("Function " + utils.Aqua(slug) + " already exists locally.")
		}
	}

	// 2. Create new function.
	{
		if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, filepath.Join(funcDir, "index.ts"), []byte(index), 0644); err != nil {
			return err
		}
	}

	fmt.Println("Created new Function at " + utils.Bold(funcDir))
	return nil
}
