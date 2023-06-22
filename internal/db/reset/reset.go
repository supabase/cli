package reset

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

const (
	SET_POSTGRES_ROLE = "SET ROLE postgres;"
	LIST_SCHEMAS      = "SELECT schema_name FROM information_schema.schemata WHERE NOT schema_name LIKE ANY($1) ORDER BY schema_name"
)

var (
	healthTimeout = 5 * time.Second
	//go:embed templates/drop.sql
	dropObjects string
)

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(config.Password) > 0 {
		fmt.Fprintln(os.Stderr, "Resetting remote database...")
		return resetRemote(ctx, config, fsys, options...)
	}

	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
	}

	// Reset postgres database because extensions (pg_cron, pg_net) require postgres
	if err := resetDatabase(ctx, fsys, options...); err != nil {
		return err
	}

	branch := keys.GetGitBranch(fsys)
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db reset")+" on branch "+utils.Aqua(branch)+".")
	return nil
}

func resetDatabase(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Resetting local database...")
	if err := RecreateDatabase(ctx, options...); err != nil {
		return err
	}
	defer RestartDatabase(context.Background(), os.Stderr)
	return initDatabase(ctx, fsys, options...)
}

func initDatabase(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	url := fmt.Sprintf("postgresql://supabase_admin:postgres@localhost:%d/postgres?connect_timeout=2", utils.Config.Db.Port)
	conn, err := utils.ConnectByUrl(ctx, url, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	fmt.Fprintln(os.Stderr, "Initializing schema...")
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql)); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, SET_POSTGRES_ROLE); err != nil {
		return err
	}
	return InitialiseDatabase(ctx, conn, fsys)
}

func InitialiseDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	if err := apply.MigrateDatabase(ctx, conn, fsys); err != nil {
		return err
	}
	return SeedDatabase(ctx, conn, fsys)
}

// Recreate postgres database by connecting to template1
func RecreateDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	url := fmt.Sprintf("postgresql://supabase_admin:postgres@localhost:%d/template1?connect_timeout=2", utils.Config.Db.Port)
	conn, err := utils.ConnectByUrl(ctx, url, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := DisconnectClients(ctx, conn); err != nil {
		return err
	}
	drop := "DROP DATABASE IF EXISTS postgres WITH (FORCE);"
	if _, err := conn.Exec(ctx, drop); err != nil {
		return err
	}
	_, err = conn.Exec(ctx, "CREATE DATABASE postgres WITH OWNER postgres;")
	return err
}

func SeedDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Seeding data "+utils.Bold(utils.SeedDataPath)+"...")
	seed, err := repair.NewMigrationFromFile(utils.SeedDataPath, fsys)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	// Batch seed commands, safe to use statement cache
	return seed.ExecBatchWithCache(ctx, conn)
}

func DisconnectClients(ctx context.Context, conn *pgx.Conn) error {
	// Must be executed separately because running in transaction is unsupported
	disconn := "ALTER DATABASE postgres ALLOW_CONNECTIONS false;"
	if _, err := conn.Exec(ctx, disconn); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code != pgerrcode.InvalidCatalogName {
			return err
		}
	}
	term := fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")
	if _, err := conn.Exec(ctx, term); err != nil {
		return err
	}
	return nil
}

func RestartDatabase(ctx context.Context, w io.Writer) {
	fmt.Fprintln(w, "Restarting containers...")
	// Some extensions must be manually restarted after pg_terminate_backend
	// Ref: https://github.com/citusdata/pg_cron/issues/99
	if err := utils.Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{}); err != nil {
		fmt.Fprintln(w, "Failed to restart database:", err)
		return
	}
	if !WaitForHealthyService(ctx, utils.DbId, healthTimeout) {
		fmt.Fprintln(w, "Database is not healthy.")
		return
	}
	// TODO: update storage-api to handle postgres restarts
	if err := utils.Docker.ContainerRestart(ctx, utils.StorageId, container.StopOptions{}); err != nil {
		fmt.Fprintln(w, "Failed to restart storage-api:", err)
	}
	// Reload PostgREST schema cache.
	if err := utils.Docker.ContainerKill(ctx, utils.RestId, "SIGUSR1"); err != nil {
		fmt.Fprintln(w, "Error reloading PostgREST schema cache:", err)
	}
	// TODO: update gotrue to handle postgres restarts
	if err := utils.Docker.ContainerRestart(ctx, utils.GotrueId, container.StopOptions{}); err != nil {
		fmt.Fprintln(w, "Failed to restart gotrue:", err)
	}
	// TODO: update realtime to handle postgres restarts
	if err := utils.Docker.ContainerRestart(ctx, utils.RealtimeId, container.StopOptions{}); err != nil {
		fmt.Fprintln(w, "Failed to restart realtime:", err)
	}
}

func RetryEverySecond(ctx context.Context, callback func() bool, timeout time.Duration) bool {
	now := time.Now()
	expiry := now.Add(timeout)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for t := now; t.Before(expiry) && ctx.Err() == nil; t = <-ticker.C {
		if callback() {
			return true
		}
	}
	return false
}

func WaitForHealthyService(ctx context.Context, container string, timeout time.Duration) bool {
	probe := func() bool {
		return status.AssertContainerHealthy(ctx, container) == nil
	}
	return RetryEverySecond(ctx, probe, timeout)
}

func resetRemote(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// List user defined schemas
	excludes := append([]string{"public"}, utils.InternalSchemas...)
	userSchemas, err := ListSchemas(ctx, conn, excludes...)
	if err != nil {
		return err
	}
	userSchemas = append(userSchemas, "supabase_migrations")
	// Drop user defined objects
	migration := repair.MigrationFile{}
	for _, schema := range userSchemas {
		sql := fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema)
		migration.Lines = append(migration.Lines, sql)
	}
	migration.Lines = append(migration.Lines, dropObjects)
	if err := migration.ExecBatch(ctx, conn); err != nil {
		return err
	}
	return InitialiseDatabase(ctx, conn, fsys)
}

func ListSchemas(ctx context.Context, conn *pgx.Conn, exclude ...string) ([]string, error) {
	exclude = likeEscapeSchema(exclude)
	rows, err := conn.Query(ctx, LIST_SCHEMAS, exclude)
	if err != nil {
		return nil, err
	}
	schemas := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		schemas = append(schemas, name)
	}
	return schemas, nil
}

func likeEscapeSchema(schemas []string) (result []string) {
	// Treat _ as literal, * as any character
	replacer := strings.NewReplacer("_", `\_`, "*", "%")
	for _, sch := range schemas {
		result = append(result, replacer.Replace(sch))
	}
	return result
}
