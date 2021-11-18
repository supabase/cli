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

const latestDbVersion = "130003" // Server version of latest supabase/postgres image on hosted platform (supabase/postgres:13.3.0)

var (
	//go:embed templates/extensions_sql
	extensionsSql []byte
	//go:embed templates/globals_sql
	globalsSql []byte
	// pg_dump --dbname $DB_URL
	//go:embed templates/init_migration_sql
	initMigrationSql []byte
	//go:embed templates/init_seed_sql
	initSeedSql []byte
	//go:embed templates/init_config
	initConfigEmbed       string
	initConfigTemplate, _ = template.New("initConfig").Parse(initConfigEmbed)
	//go:embed templates/init_gitignore
	initGitignore []byte
)

func Init() error {
	if err := run(); err != nil {
		_ = os.RemoveAll("supabase")
		return err
	}

	return nil
}

func run() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); err == nil {
			fmt.Fprintln(
				os.Stderr,
				"Project already initialized. Remove `supabase` directory to reinitialize.",
			)
			os.Exit(1)
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
	if err := os.WriteFile("supabase/extensions.sql", extensionsSql, 0644); err != nil {
		return err
	}
	if err := os.WriteFile("supabase/globals.sql", globalsSql, 0644); err != nil {
		return err
	}

	// 3. Write `config.json`.
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

	// 4. Write `seed.sql`.
	if err := os.WriteFile("supabase/seed.sql", initSeedSql, 0644); err != nil {
		return err
	}

	// 5. Append to `.gitignore`.
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

	fmt.Println("Finished `supabase init`.")
	return nil
}
