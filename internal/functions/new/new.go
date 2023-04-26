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
	//go:embed templates/vscode/extensions.json
	vscodeExtensions string
	//go:embed templates/vscode/settings.json
	vscodeSettings string
)

func Run(ctx context.Context, slug string, fsys afero.Fs) error {
	// 1. Sanity checks.
	funcDir := filepath.Join(utils.FunctionsDir, slug)
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

	// 3. Set up VS Code Settings
	{
		vscodeDir := filepath.Join (utils.FunctionsDir, ".vscode")
		if _, err := fsys.Stat(vscodeDir); !errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err := utils.MkdirIfNotExistFS(fsys, vscodeDir); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, filepath.Join(vscodeDir, "extensions.json"), []byte(vscodeExtensions), 0644); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, filepath.Join(vscodeDir, "settings.json"), []byte(vscodeSettings), 0644); err != nil {
			return err
		}
	}

	fmt.Println("Created new Function at " + utils.Bold(funcDir))
	return nil
}
