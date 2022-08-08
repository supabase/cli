package diff

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

const (
	diffImage = "djrobstep/migra:3.0.1621480950"
)

var (
	initSchemaPattern = regexp.MustCompile(`([0-9]{14})_init\.sql`)
	//go:embed templates/migra.sh
	diffSchemaScript string
	//go:embed templates/reset.sh
	resetShadowScript string
)

func RunMigra(ctx context.Context, schema []string, file string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
	}

	var opts []func(*pgx.ConnConfig)
	if viper.GetBool("DEBUG") {
		opts = append(opts, debug.SetupPGX)
	}

	fmt.Fprintln(os.Stderr, "Creating shadow database...")
	if err := createShadowDb(ctx, utils.DbId, utils.ShadowDbName); err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Initialising schema...")
	url := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/%s", utils.Config.Db.Port, utils.ShadowDbName)
	if err := applyMigrations(ctx, url, fsys, opts...); err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Diffing local database...")
	source := "postgresql://postgres:postgres@" + utils.DbId + ":5432/" + utils.ShadowDbName
	target := "postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres"
	out, err := diffSchema(ctx, source, target, schema)
	if err != nil {
		return err
	}

	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted " + utils.Aqua("supabase db diff") + ".")
	}

	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		branch = "<unknown>"
	}
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db diff")+" on branch "+utils.Aqua(branch)+".\n")

	if len(out) < 2 {
		fmt.Fprintln(os.Stderr, "No changes found")
	} else if len(file) > 0 {
		// Pipe to new migration command
		r, w, err := os.Pipe()
		if err != nil {
			return err
		}
		w.WriteString(out)
		return new.Run(file, r, fsys)
	} else {
		fmt.Println(out)
	}
	return nil
}

func toBatchQuery(contents string) (batch pgx.Batch) {
	var lines []string
	for _, line := range strings.Split(contents, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) == 0 || strings.HasPrefix(trimmed, "--") {
			continue
		}
		lines = append(lines, trimmed)
		if strings.HasSuffix(trimmed, ";") {
			query := strings.Join(lines, "\n")
			batch.Queue(query[:len(query)-1])
			lines = nil
		}
	}
	if len(lines) > 0 {
		batch.Queue(strings.Join(lines, "\n"))
	}
	return batch
}

// Creates a fresh database inside supabase_cli_db container.
func createShadowDb(ctx context.Context, container, shadow string) error {
	// Reset shadow database
	env := []string{"DB_NAME=" + shadow, "SCHEMA=" + utils.InitialSchemaSql}
	cmd := []string{"/bin/bash", "-c", resetShadowScript}
	if _, err := utils.DockerExecOnce(ctx, container, env, cmd); err != nil {
		return errors.New("error creating shadow database")
	}
	return nil
}

// Applies local migration scripts to a database.
func applyMigrations(ctx context.Context, url string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	// Apply migrations
	if migrations, err := afero.ReadDir(fsys, utils.MigrationsDir); err == nil {
		for i, migration := range migrations {
			// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
			// the first migration (prev versions of the CLI) is deprecated.
			if i == 0 {
				matches := initSchemaPattern.FindStringSubmatch(migration.Name())
				if len(matches) == 2 {
					if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err != nil {
						// Unreachable due to regex valdiation, but return just in case
						return err
					} else if timestamp < 20211209000000 {
						continue
					}
				}
			}
			fmt.Fprintln(os.Stderr, "Applying migration "+utils.Bold(migration.Name())+"...")
			contents, err := afero.ReadFile(fsys, filepath.Join(utils.MigrationsDir, migration.Name()))
			if err != nil {
				return err
			}
			batch := toBatchQuery(string(contents))
			if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
				return err
			}
		}
	}
	return nil
}

// Diffs local database schema against shadow, dumps output to stdout.
func diffSchema(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	out, err := utils.DockerRunOnce(ctx, diffImage, env, cmd)
	if err != nil {
		return "", errors.New("error diffing scheam")
	}
	return out, nil
}
