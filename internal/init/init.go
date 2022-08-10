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
	//go:embed templates/init_gitignore
	initGitignore []byte
)

func Run(fsys afero.Fs) error {
	// Sanity checks.
	{
		if _, err := fsys.Stat(utils.ConfigPath); err == nil {
			fmt.Fprintln(os.Stderr, "Project already initialized. Remove "+utils.Bold("supabase")+" to reinitialize.")
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	// 1. Write `config.toml`.
	if err := utils.WriteConfig(fsys, false); err != nil {
		return err
	}

	// 2. Append to `.gitignore`.
	if gitRoot, _ := utils.GetGitRoot(fsys); gitRoot == nil {
		// User not using git
		return nil
	}

	ignorePath := filepath.Join(filepath.Dir(utils.ConfigPath), ".gitignore")
	if err := updateGitIgnore(ignorePath, fsys); err != nil {
		return err
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
