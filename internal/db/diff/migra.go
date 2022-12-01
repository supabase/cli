package diff

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

var (
	//go:embed templates/migra.sh
	diffSchemaScript string
)

func RunMigra(ctx context.Context, schema []string, file string, password string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// 1. Determine local or remote target
	target, err := buildTargetUrl(password, fsys)
	if err != nil {
		return err
	}
	// 2. Create shadow database
	fmt.Fprintln(os.Stderr, "Creating shadow database...")
	shadow, err := createShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerStop(shadow)
	if err := migrateShadowDatabase(ctx, fsys, options...); err != nil {
		return err
	}
	// 3. Run migra to diff schema
	progress := "Diffing local database..."
	if len(password) > 0 {
		progress = "Diffing linked project..."
	}
	fmt.Fprintln(os.Stderr, progress)
	source := "postgresql://postgres:postgres@" + shadow[:12] + ":5432/postgres"
	out, err := diffSchema(ctx, source, target, schema)
	if err != nil {
		return err
	}
	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		branch = "main"
	}
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db diff")+" on branch "+utils.Aqua(branch)+".\n")
	return SaveDiff(out, file, fsys)
}

// Builds a postgres connection string for local or remote database
func buildTargetUrl(password string, fsys afero.Fs) (target string, err error) {
	if len(password) > 0 {
		ref, err := utils.LoadProjectRef(fsys)
		if err != nil {
			return target, err
		}
		target = fmt.Sprintf(
			"postgresql://%s@%s:6543/postgres",
			url.UserPassword("postgres", password),
			utils.GetSupabaseDbHost(ref),
		)
	} else {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return target, err
		}
		target = "postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres"
	}
	return target, err
}

func createShadowDatabase(ctx context.Context) (string, error) {
	config := container.Config{
		Image: utils.DbImage,
		Env:   []string{"POSTGRES_PASSWORD=postgres"},
	}
	if utils.Config.Db.MajorVersion >= 14 {
		config.Cmd = []string{"postgres",
			"-c", "config_file=/etc/postgresql/postgresql.conf",
			// Ref: https://postgrespro.com/list/thread-id/2448092
			"-c", `search_path="$user",public,extensions`,
		}
	}
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.ShadowPort), 10)
	hostConfig := container.HostConfig{
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		Binds:        []string{"/dev/null:/docker-entrypoint-initdb.d/migrate.sh:ro"},
		AutoRemove:   true,
	}
	return utils.DockerStart(ctx, config, hostConfig, "")
}

func connectShadowDatabase(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) (conn *pgx.Conn, err error) {
	now := time.Now()
	expiry := now.Add(timeout)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	// Retry until connected, cancelled, or timeout
	for t := now; t.Before(expiry); t = <-ticker.C {
		conn, err = utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.ShadowPort, "postgres", options...)
		if err == nil || errors.Is(ctx.Err(), context.Canceled) {
			break
		}
	}
	return conn, err
}

func migrateShadowDatabase(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := connectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	fmt.Fprintln(os.Stderr, "Initialising schema...")
	if err := BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}
	if err := BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql)); err != nil {
		return err
	}
	return MigrateDatabase(ctx, conn, fsys)
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
	migrations, err := list.LoadLocalMigrations(fsys)
	if err != nil {
		return err
	}
	// Apply migrations
	for _, filename := range migrations {
		fmt.Fprintln(os.Stderr, "Applying migration "+utils.Bold(filename)+"...")
		sql, err := fsys.Open(filepath.Join(utils.MigrationsDir, filename))
		if err != nil {
			return err
		}
		defer sql.Close()
		if err := BatchExecDDL(ctx, conn, sql); err != nil {
			return err
		}
	}
	return nil
}

func BatchExecDDL(ctx context.Context, conn *pgx.Conn, sql io.Reader) error {
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return err
	}
	// Batch migration commands, without using statement cache
	batch := pgconn.Batch{}
	for _, line := range lines {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	if result, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		i := len(result)
		var stat string
		if i < len(lines) {
			stat = lines[i]
		}
		return fmt.Errorf("%v\nAt statement %d: %s", err, i, utils.Aqua(stat))
	}
	return nil
}

// Diffs local database schema against shadow, dumps output to stdout.
func diffSchema(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	out, err := utils.DockerRunOnce(ctx, utils.MigraImage, env, cmd)
	if err != nil {
		return "", errors.New("error diffing schema")
	}
	return out, nil
}
