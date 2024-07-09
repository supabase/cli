package reset

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/errdefs"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

var (
	//go:embed templates/drop.sql
	dropObjects string
	//go:embed templates/list.sql
	ListSchemas string
)

func Run(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(version) > 0 {
		if _, err := strconv.Atoi(version); err != nil {
			return errors.New(repair.ErrInvalidVersion)
		}
		if _, err := repair.GetMigrationFile(version, fsys); err != nil {
			return err
		}
	}
	if !utils.IsLocalDatabase(config) {
		msg := "Do you want to reset the remote database?"
		if shouldReset, err := utils.NewConsole().PromptYesNo(ctx, msg, false); err != nil {
			return err
		} else if !shouldReset {
			return errors.New(context.Canceled)
		}
		return resetRemote(ctx, version, config, fsys, options...)
	}

	// Config file is loaded before parsing --linked or --local flags
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
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
	if err := utils.Docker.ContainerRemove(ctx, utils.DbId, container.RemoveOptions{Force: true}); err != nil {
		return errors.Errorf("failed to remove container: %w", err)
	}
	if err := utils.Docker.VolumeRemove(ctx, utils.DbId, true); err != nil {
		return errors.Errorf("failed to remove volume: %w", err)
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
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, utils.DbId); err != nil {
		return err
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
	sql := utils.InitialSchemaPg14Sql
	if utils.Config.Db.MajorVersion == 13 {
		sql = utils.InitialSchemaPg13Sql
	}
	return apply.BatchExecDDL(ctx, conn, strings.NewReader(sql))
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
			return errors.Errorf("failed to disconnect clients: %w", err)
		}
	}
	term := fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")
	if _, err := conn.Exec(ctx, term); err != nil {
		return errors.Errorf("failed to terminate backend: %w", err)
	}
	return nil
}

func RestartDatabase(ctx context.Context, w io.Writer) error {
	fmt.Fprintln(w, "Restarting containers...")
	// Some extensions must be manually restarted after pg_terminate_backend
	// Ref: https://github.com/citusdata/pg_cron/issues/99
	if err := utils.Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{}); err != nil {
		return errors.Errorf("failed to restart container: %w", err)
	}
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, utils.DbId); err != nil {
		return err
	}
	return restartServices(ctx)
}

func restartServices(ctx context.Context) error {
	// No need to restart PostgREST because it automatically reconnects and listens for schema changes
	services := []string{utils.StorageId, utils.GotrueId, utils.RealtimeId}
	result := utils.WaitAll(services, func(id string) error {
		if err := utils.Docker.ContainerRestart(ctx, id, container.StopOptions{}); err != nil && !errdefs.IsNotFound(err) {
			return errors.Errorf("Failed to restart %s: %w", id, err)
		}
		return nil
	})
	// Do not wait for service healthy as those services may be excluded from starting
	return errors.Join(result...)
}

func resetRemote(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Resetting remote database"+toLogMessage(version))
	conn, err := utils.ConnectByConfigStream(ctx, config, io.Discard, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Only drop objects in extensions and public schema
	excludes := append([]string{
		"extensions",
		"public",
	}, utils.ManagedSchemas...)
	userSchemas, err := LoadUserSchemas(ctx, conn, excludes...)
	if err != nil {
		return err
	}
	// Drop all user defined schemas
	migration := repair.MigrationFile{}
	for _, schema := range userSchemas {
		sql := fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema)
		migration.Lines = append(migration.Lines, sql)
	}
	// If an extension uses a schema it doesn't create, dropping the schema will cascade to also
	// drop the extension. But if an extension creates its own schema, dropping the schema will
	// throw an error. Hence, we drop the extension instead so it cascades to its own schema.
	migration.Lines = append(migration.Lines, dropObjects)
	if err := migration.ExecBatch(ctx, conn); err != nil {
		return err
	}
	return apply.MigrateAndSeed(ctx, version, conn, fsys)
}

func LoadUserSchemas(ctx context.Context, conn *pgx.Conn, exclude ...string) ([]string, error) {
	if len(exclude) == 0 {
		exclude = utils.ManagedSchemas
	}
	exclude = LikeEscapeSchema(exclude)
	rows, err := conn.Query(ctx, ListSchemas, exclude)
	if err != nil {
		return nil, errors.Errorf("failed to list schemas: %w", err)
	}
	// TODO: show detail and hint from pgconn.PgError
	return pgxv5.CollectStrings(rows)
}

func LikeEscapeSchema(schemas []string) (result []string) {
	// Treat _ as literal, * as any character
	replacer := strings.NewReplacer("_", `\_`, "*", "%")
	for _, sch := range schemas {
		result = append(result, replacer.Replace(sch))
	}
	return result
}
