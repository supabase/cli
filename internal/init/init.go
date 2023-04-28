package init

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/.gitignore
	initGitignore []byte
	//go:embed templates/.vscode/extensions.json
	vscodeExtensions string
	//go:embed templates/.vscode/settings.json
	vscodeSettings string
	//go:embed templates/.code-workspace
	vscodeWorkspaceConfig string

	errAlreadyInitialized = errors.New("Project already initialized. Remove " + utils.Bold(utils.ConfigPath) + " to reinitialize.")
)

func Run(fsys afero.Fs) error {
	// Sanity checks.
	{
		if _, err := fsys.Stat(utils.ConfigPath); err == nil {
			return errAlreadyInitialized
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	// 1. Write `config.toml`.
	if err := utils.WriteConfig(fsys, false); err != nil {
		return err
	}

	// 2. Create `seed.sql`.
	if _, err := fsys.Create(utils.SeedDataPath); err != nil {
		return err
	}

	// 3. Append to `.gitignore`.
	if gitRoot, _ := utils.GetGitRoot(fsys); gitRoot != nil {
		if err := updateGitIgnore(utils.GitIgnorePath, fsys); err != nil {
			return err
		}
	}

	// 4. Generate VS Code workspace settings.
	if isVscode := utils.PromptYesNo("Generate VS Code workspace settings?", false, os.Stdin); isVscode {
		return writeVscodeConfig(fsys)
	}
	return nil
}

func updateGitIgnore(ignorePath string, fsys afero.Fs) error {
	var contents []byte

	if contained, err := afero.FileContainsBytes(fsys, ignorePath, initGitignore); contained {
		return nil
	} else if err == nil {
		// Add a line break when appending
		contents = append(contents, '\n')
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	f, err := fsys.OpenFile(ignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Write(append(contents, initGitignore...)); err != nil {
		return err
	}

	return nil
}

func writeVscodeConfig(fsys afero.Fs) error {
	{
		// Create mutli-root code-workspace.
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		codeWorkspaceConfigPath := filepath.Join(cwd, filepath.Base(cwd)+".code-workspace")
		if _, err := fsys.Stat(codeWorkspaceConfigPath); !errors.Is(err, os.ErrNotExist) {
			// TODO: prompt to overwrite if config already exists
			return err
		}
		if err := afero.WriteFile(fsys, codeWorkspaceConfigPath, []byte(vscodeWorkspaceConfig), 0644); err != nil {
			return err
		}
		fmt.Println("Open the " + utils.Aqua(filepath.Base(codeWorkspaceConfigPath)) + " file in VS Code.")
	}

	{
		// Create functions workspace settings.
		vscodeDir := filepath.Join(utils.FunctionsDir, ".vscode")
		if _, err := fsys.Stat(vscodeDir); !errors.Is(err, os.ErrNotExist) {
			return err
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
	return nil
}
