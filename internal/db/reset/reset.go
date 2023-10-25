package reset

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
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
	ErrUnhealthy   = errors.New("service not healthy")
	serviceTimeout = 30 * time.Second
	//go:embed templates/drop.sql
	dropObjects string
)

func Run(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(version) > 0 {
		if _, err := strconv.Atoi(version); err != nil {
			return repair.ErrInvalidVersion
		}
		if _, err := repair.GetMigrationFile(version, fsys); err != nil {
			return err
		}
	}
	if !utils.IsLoopback(config.Host) {
		if shouldReset := utils.PromptYesNo("Confirm resetting the remote database?", true, os.Stdin); !shouldReset {
			return context.Canceled
		}
		return resetRemote(ctx, version, config, fsys, options...)
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
	if err := resetDatabase(ctx, version, fsys, options...); err != nil {
		return err
	}

	branch := keys.GetGitBranch(fsys)
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db reset")+" on branch "+utils.Aqua(branch)+".")
	return nil
}

func resetDatabase(ctx context.Context, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Resetting local database"+toLogMessage(version))
	if utils.Config.Db.MajorVersion <= 14 {
		return resetDatabase14(ctx, version, fsys, options...)
	}
	return resetDatabase15(ctx, version, fsys, options...)
}

func toLogMessage(version string) string {
	if len(version) > 0 {
		return " to version: " + version
	}
	return "..."
}

func resetDatabase14(ctx context.Context, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := recreateDatabase(ctx, options...); err != nil {
		return err
	}
	if err := initDatabase(ctx, options...); err != nil {
		return err
	}
	if err := RestartDatabase(ctx, os.Stderr); err != nil {
		return err
	}
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if utils.Config.Db.MajorVersion > 14 {
		if err := start.SetupDatabase(ctx, conn, utils.DbId, os.Stderr, fsys); err != nil {
			return err
		}
	}
	return apply.MigrateAndSeed(ctx, version, conn, fsys)
}

func resetDatabase15(ctx context.Context, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := utils.Docker.ContainerRemove(ctx, utils.DbId, types.ContainerRemoveOptions{Force: true}); err != nil {
		return err
	}
	if err := utils.Docker.VolumeRemove(ctx, utils.DbId, true); err != nil {
		return err
	}
	// Skip syslog if vector container is not started
	if _, err := utils.Docker.ContainerInspect(ctx, utils.VectorId); err != nil {
		utils.Config.Analytics.Enabled = false
	}
	config := start.NewContainerConfig()
	hostConfig := start.NewHostConfig()
	networkingConfig := network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			utils.NetId: {
				Aliases: utils.DbAliases,
			},
		},
	}
	fmt.Fprintln(os.Stderr, "Recreating database...")
	if _, err := utils.DockerStart(ctx, config, hostConfig, networkingConfig, utils.DbId); err != nil {
		return err
	}
	if !start.WaitForHealthyService(ctx, utils.DbId, start.HealthTimeout) {
		return start.ErrDatabase
	}
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := start.SetupDatabase(ctx, conn, utils.DbId, os.Stderr, fsys); err != nil {
		return err
	}
	if err := apply.MigrateAndSeed(ctx, version, conn, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Restarting containers...")
	return restartServices(ctx)
}

func initDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{User: "supabase_admin"}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql))
}

// Recreate postgres database by connecting to template1
func recreateDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{User: "supabase_admin", Database: "template1"}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := DisconnectClients(ctx, conn); err != nil {
		return err
	}
	// We are not dropping roles here because they are cluster level entities. Use stop && start instead.
	sql := repair.MigrationFile{
		Lines: []string{
			"DROP DATABASE IF EXISTS postgres WITH (FORCE)",
			"CREATE DATABASE postgres WITH OWNER postgres",
		},
	}
	return sql.ExecBatch(ctx, conn)
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
	_, err := conn.Exec(ctx, term)
	return err
}

func RestartDatabase(ctx context.Context, w io.Writer) error {
	fmt.Fprintln(w, "Restarting containers...")
	// Some extensions must be manually restarted after pg_terminate_backend
	// Ref: https://github.com/citusdata/pg_cron/issues/99
	if err := utils.Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{}); err != nil {
		return err
	}
	if !start.WaitForHealthyService(ctx, utils.DbId, start.HealthTimeout) {
		return start.ErrDatabase
	}
	return restartServices(ctx)
}

func restartServices(ctx context.Context) error {
	// No need to restart PostgREST because it automatically reconnects and listens for schema changes
	services := []string{utils.StorageId, utils.GotrueId, utils.RealtimeId}
	result := utils.WaitAll(services, func(id string) error {
		if err := utils.Docker.ContainerRestart(ctx, id, container.StopOptions{}); err != nil && !errdefs.IsNotFound(err) {
			return fmt.Errorf("Failed to restart %s: %w", id, err)
		}
		return nil
	})
	// Do not wait for service healthy as those services may be excluded from starting
	return errors.Join(result...)
}

func WaitForServiceReady(ctx context.Context, started []string) error {
	probe := func() bool {
		var unhealthy []string
		for _, container := range started {
			if !status.IsServiceReady(ctx, container) {
				unhealthy = append(unhealthy, container)
			}
		}
		started = unhealthy
		return len(started) == 0
	}
	if !start.RetryEverySecond(ctx, probe, serviceTimeout) {
		// Print container logs for easier debugging
		for _, container := range started {
			logs, err := utils.Docker.ContainerLogs(ctx, container, types.ContainerLogsOptions{
				ShowStdout: true,
				ShowStderr: true,
			})
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				continue
			}
			fmt.Fprintln(os.Stderr, container, "container logs:")
			if _, err := stdcopy.StdCopy(os.Stderr, os.Stderr, logs); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
			logs.Close()
		}
		return fmt.Errorf("%w: %v", ErrUnhealthy, started)
	}
	return nil
}

func resetRemote(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Resetting remote database"+toLogMessage(version))
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
	return apply.MigrateAndSeed(ctx, version, conn, fsys)
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
	return schemas, rows.Err()
}

func likeEscapeSchema(schemas []string) (result []string) {
	// Treat _ as literal, * as any character
	replacer := strings.NewReplacer("_", `\_`, "*", "%")
	for _, sch := range schemas {
		result = append(result, replacer.Replace(sch))
	}
	return result
}
