package init

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"

	"github.com/supabase/cli/internal/utils"
)

var (
	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	// pg_dump --dbname $DB_URL
	//go:embed templates/init_gitignore
	initGitignore []byte

	errAlreadyInitialized = errors.New("Project already initialized. Remove " + utils.Bold("supabase") + " to reinitialize.")
)

func Run() error {
	if err := run(); errors.Is(err, errAlreadyInitialized) {
		return err
	} else if err != nil {
		_ = os.RemoveAll("supabase")
		return err
	}

	return nil
}

func run() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); err == nil {
			return errAlreadyInitialized
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	if err := os.Mkdir("supabase", 0755); err != nil {
		return err
	}

	// 1. Write `config.toml`.
	if err := utils.WriteConfig(false); err != nil {
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
			gitignore, err := os.ReadFile(gitignorePath)
			if errors.Is(err, os.ErrNotExist) {
				if err := os.WriteFile(gitignorePath, initGitignore, 0644); err != nil {
					return err
				}
			} else if err != nil {
				return err
			} else if bytes.Contains(gitignore, initGitignore) {
				// skip
			} else {
				f, err := os.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
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

	fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
	return nil
}
