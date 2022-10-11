package diff

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
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
	if err := ResetDatabase(ctx, utils.DbId, utils.ShadowDbName); err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Initialising schema...")
	url := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/%s", utils.Config.Db.Port, utils.ShadowDbName)
	if err := ApplyMigrations(ctx, url, fsys, opts...); err != nil {
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

	return SaveDiff(out, file, fsys)
}

// Creates a fresh database inside a Postgres container.
func ResetDatabase(ctx context.Context, container, shadow string) error {
	// Our initial schema should not exceed the maximum size of an env var, ~32KB
	env := []string{"DB_NAME=" + shadow, "SCHEMA=" + utils.InitialSchemaSql}
	cmd := []string{"/bin/bash", "-c", resetShadowScript}
	if _, err := utils.DockerExecOnce(ctx, container, env, cmd); err != nil {
		return errors.New("error creating shadow database")
	}
	return nil
}

// Applies local migration scripts to a database.
func ApplyMigrations(ctx context.Context, url string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
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
	defer conn.Close(context.Background())
	return MigrateDatabase(ctx, conn, fsys)
}

func MigrateDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
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
			sql, err := fsys.Open(filepath.Join(utils.MigrationsDir, migration.Name()))
			if err != nil {
				return err
			}
			defer sql.Close()
			if err := BatchExecDDL(ctx, conn, sql); err != nil {
				return err
			}
		}
	}
	return nil
}

func BatchExecDDL(ctx context.Context, conn *pgx.Conn, sql io.Reader) error {
	// Batch migration commands, without using statement cache
	batch := pgconn.Batch{}
	lines, err := parser.Split(sql)
	if err != nil {
		return err
	}
	for _, line := range lines {
		trim := strings.TrimSpace(strings.TrimRight(line, ";"))
		if len(trim) > 0 {
			batch.ExecParams(trim, nil, nil, nil, nil)
		}
	}
	return conn.PgConn().ExecBatch(ctx, &batch).Close()
}

// Diffs local database schema against shadow, dumps output to stdout.
func diffSchema(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	out, err := utils.DockerRunOnce(ctx, utils.MigraImage, env, cmd)
	if err != nil {
		return "", errors.New("error diffing scheam")
	}
	return out, nil
}
