package reset

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

var (
	healthTimeout = 5 * time.Second
)

func Run(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
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
	{
		fmt.Fprintln(os.Stderr, "Resetting database...")
		if err := RecreateDatabase(ctx, options...); err != nil {
			return err
		}
		defer RestartDatabase(context.Background())
		if err := resetDatabase(ctx, fsys, options...); err != nil {
			return err
		}
	}

	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		// Assume we are on main branch
		branch = "main"
	}
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db reset")+" on branch "+utils.Aqua(branch)+".")

	return nil
}

func resetDatabase(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	url := fmt.Sprintf("postgresql://supabase_admin:postgres@localhost:%d/postgres?connect_timeout=2", utils.Config.Db.Port)
	conn, err := utils.ConnectByUrl(ctx, url, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	fmt.Fprintln(os.Stderr, "Initialising schema...")
	return InitialiseDatabase(ctx, conn, fsys)
}

func InitialiseDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	if err := diff.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql)); err != nil {
		return err
	}
	if err := diff.MigrateDatabase(ctx, conn, fsys); err != nil {
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
	_, err = conn.Exec(ctx, "CREATE DATABASE postgres;")
	return err
}

func SeedDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	sql, err := fsys.Open(utils.SeedDataPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	defer sql.Close()
	fmt.Fprintln(os.Stderr, "Seeding data "+utils.Bold(utils.SeedDataPath)+"...")
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return err
	}
	// Batch seed commands, safe to use statement cache
	batch := pgx.Batch{}
	for _, line := range lines {
		batch.Queue(line)
	}
	return conn.SendBatch(ctx, &batch).Close()
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

func RestartDatabase(ctx context.Context) {
	// Some extensions must be manually restarted after pg_terminate_backend
	// Ref: https://github.com/citusdata/pg_cron/issues/99
	if err := utils.Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{}); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to restart database:", err)
		return
	}
	if !WaitForHealthyService(ctx, utils.DbId, healthTimeout) {
		fmt.Fprintln(os.Stderr, "Database is not healthy.")
		return
	}
	// TODO: update storage-api to handle postgres restarts
	if err := utils.Docker.ContainerRestart(ctx, utils.StorageId, container.StopOptions{}); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to restart storage-api:", err)
	}
	// Reload PostgREST schema cache.
	if err := utils.Docker.ContainerKill(ctx, utils.RestId, "SIGUSR1"); err != nil {
		fmt.Fprintln(os.Stderr, "Error reloading PostgREST schema cache:", err)
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
