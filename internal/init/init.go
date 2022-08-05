package init

import (
	"bytes"
	_ "embed"
	"errors"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/init_gitignore
	initGitignore []byte

	errAlreadyInitialized = errors.New("Project already initialized. Remove " + utils.Bold("supabase") + " to reinitialize.")
)

func Run(fsys afero.Fs) error {
	if err := run(fsys); errors.Is(err, errAlreadyInitialized) {
		return err
	} else if err != nil {
		_ = fsys.RemoveAll("supabase")
		return err
	}

	return nil
}

func run(fsys afero.Fs) error {
	// Sanity checks.
	{
		if _, err := fsys.Stat(utils.ConfigPath); err == nil {
			return errAlreadyInitialized
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.ConfigPath)); err != nil {
		return err
	}

	// 1. Write `config.toml`.
	if err := utils.WriteConfig(fsys, false); err != nil {
		return err
	}

	// 2. Append to `.gitignore`.
	{
		gitRoot, err := utils.GetGitRoot()
		if err != nil {
			return err
		} else if gitRoot == nil {
			// skip
		} else {
			gitignorePath := *gitRoot + "/.gitignore"
			gitignore, err := afero.ReadFile(fsys, gitignorePath)
			if errors.Is(err, os.ErrNotExist) {
				if err := afero.WriteFile(fsys, gitignorePath, initGitignore, 0644); err != nil {
					return err
				}
			} else if err != nil {
				return err
			} else if bytes.Contains(gitignore, initGitignore) {
				// skip
			} else {
				f, err := fsys.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
				if err != nil {
					return err
				}
				if _, err := f.Write(append([]byte("\n"), initGitignore...)); err != nil {
					return err
				}
				if err := f.Close(); err != nil {
					return err
				}
			}
		}
	}

	return nil
}
