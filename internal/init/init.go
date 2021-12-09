package init

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"text/template"

	"github.com/supabase/cli/internal/utils"
)

const latestDbVersion = "140001" // Server version of latest supabase/postgres image on hosted platform (supabase/postgres:14.1.0)

var (
	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	//go:embed templates/globals_sql
	globalsSql []byte
	// pg_dump --dbname $DB_URL
	//go:embed templates/init_migration_sql
	initMigrationSql []byte
	//go:embed templates/init_config
	initConfigEmbed       string
	initConfigTemplate, _ = template.New("initConfig").Parse(initConfigEmbed)
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

		if _, err := utils.GetGitRoot(); err != nil {
			return err
		}
	}

	if err := os.Mkdir("supabase", 0755); err != nil {
		return err
	}

	// 1. Write `migrations`.
	if err := os.Mkdir("supabase/migrations", 0755); err != nil {
		return err
	}
	if err := os.WriteFile(
		"supabase/migrations/"+utils.GetCurrentTimestamp()+"_init.sql",
		initMigrationSql,
		0644,
	); err != nil {
		return err
	}

	// 2. Write `extensions.sql`, `globals.sql`.
	if err := os.WriteFile("supabase/globals.sql", globalsSql, 0644); err != nil {
		return err
	}

	// 2. Write `config.json`.
	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		dir := filepath.Base(cwd)

		var initConfigBuf bytes.Buffer
		if err := initConfigTemplate.Execute(
			&initConfigBuf,
			struct{ ProjectId, DbVersion string }{
				ProjectId: dir,
				DbVersion: latestDbVersion,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/config.json", initConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
	}

	// 3. Append to `.gitignore`.
	{
		gitRoot, err := utils.GetGitRoot()
		if err != nil {
			return err
		}
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

	fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
	return nil
}
