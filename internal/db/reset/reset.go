package reset

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	dbstart "github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/down"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/seed/buckets"
	stackstart "github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var (
	assertSupabaseDbIsRunning = utils.AssertSupabaseDbIsRunning
	removeContainer           = utils.RemoveContainer
	removeVolume              = utils.RemoveVolume
	startContainer            = utils.DockerStart
	inspectContainer          = utils.InspectContainer
	restartContainer          = utils.RestartContainer
	waitForHealthyService     = dbstart.WaitForHealthyService
	waitForLocalDatabase      = waitForDatabaseReady
	waitForLocalAPI           = waitForAPIReady
	setupLocalDatabase        = dbstart.SetupLocalDatabase
	restartKong               = stackstart.RestartKong
	runBucketSeed             = buckets.Run
	seedBuckets               = seedBucketsWithRetry
)

func Run(ctx context.Context, version string, last uint, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if len(version) > 0 {
		if _, err := strconv.Atoi(version); err != nil {
			return errors.New(repair.ErrInvalidVersion)
		}
		if _, err := repair.GetMigrationFile(version, fsys); err != nil {
			return err
		}
	} else if last > 0 {
		localMigrations, err := list.LoadLocalVersions(fsys)
		if err != nil {
			return err
		}
		if total := uint(len(localMigrations)); last < total {
			version = localMigrations[total-last-1]
		} else {
			// Negative skips all migrations
			version = "-"
		}
	}
	if !utils.IsLocalDatabase(config) {
		return resetRemote(ctx, version, config, fsys, options...)
	}
	// Config file is loaded before parsing --linked or --local flags
	if err := assertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// Reset postgres database because extensions (pg_cron, pg_net) require postgres
	if err := resetDatabase(ctx, version, fsys, options...); err != nil {
		return err
	}
	// Seed objects from supabase/buckets directory
	if _, err := inspectContainer(ctx, utils.StorageId); err == nil {
		if shouldRefreshAPIAfterReset() {
			// Kong caches upstream addresses; recreate it after the db container gets a new IP.
			if err := restartKong(ctx, stackstart.KongDependencies{
				Gotrue:   utils.Config.Auth.Enabled,
				Rest:     utils.Config.Api.Enabled,
				Realtime: utils.Config.Realtime.Enabled,
				Storage:  utils.Config.Storage.Enabled,
				Studio:   utils.Config.Studio.Enabled,
				Pgmeta:   utils.Config.Studio.Enabled,
				Edge:     true,
				Logflare: utils.Config.Analytics.Enabled,
				Pooler:   utils.Config.Db.Pooler.Enabled,
			}); err != nil {
				return err
			}
			if err := waitForLocalAPI(ctx, 30*time.Second); err != nil {
				return err
			}
		}
		if err := waitForHealthyService(ctx, 30*time.Second, utils.StorageId); err != nil {
			return err
		}
		if err := seedBuckets(ctx, fsys); err != nil {
			return err
		}
	}
	branch := utils.GetGitBranch(fsys)
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase db reset")+" on branch "+utils.Aqua(branch)+".")
	return nil
}

// shouldRefreshAPIAfterReset returns true when Kong must be recreated after a
// database reset.  Apple containers assign dynamic IPs, so Kong's cached
// upstream addresses become stale when the database container is replaced.
func shouldRefreshAPIAfterReset() bool {
	return utils.UsesAppleContainerRuntime() && utils.Config.Api.Enabled
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
	return apply.MigrateAndSeed(ctx, version, conn, fsys)
}

func resetDatabase15(ctx context.Context, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := removeContainer(ctx, utils.DbId, true, true); err != nil {
		return errors.Errorf("failed to remove container: %w", err)
	}
	if err := removeVolume(ctx, utils.DbId, true); err != nil {
		return errors.Errorf("failed to remove volume: %w", err)
	}
	config := dbstart.NewContainerConfig()
	hostConfig := dbstart.NewHostConfig()
	networkingConfig := network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			utils.NetId: {
				Aliases: utils.DbAliases,
			},
		},
	}
	fmt.Fprintln(os.Stderr, "Recreating database...")
	if _, err := startContainer(ctx, config, hostConfig, networkingConfig, utils.DbId); err != nil {
		return err
	}
	if err := waitForHealthyService(ctx, utils.Config.Db.HealthTimeout, utils.DbId); err != nil {
		return err
	}
	if err := waitForLocalDatabase(ctx, utils.Config.Db.HealthTimeout, options...); err != nil {
		return err
	}
	if err := setupLocalDatabase(ctx, version, fsys, os.Stderr, options...); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Restarting containers...")
	return restartServices(ctx)
}

func initDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{User: utils.SUPERUSER_ROLE}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return dbstart.InitSchema14(ctx, conn)
}

// Recreate postgres database by connecting to template1
func recreateDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{User: utils.SUPERUSER_ROLE, Database: "template1"}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := DisconnectClients(ctx, conn); err != nil {
		return err
	}
	// We are not dropping roles here because they are cluster level entities. Use stop && start instead.
	sql := migration.MigrationFile{
		Statements: []string{
			"DROP DATABASE IF EXISTS postgres WITH (FORCE)",
			"CREATE DATABASE postgres WITH OWNER postgres",
			"DROP DATABASE IF EXISTS _supabase WITH (FORCE)",
			"CREATE DATABASE _supabase WITH OWNER postgres",
		},
	}
	return sql.ExecBatch(ctx, conn)
}

const (
	TERMINATE_BACKENDS      = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('postgres', '_supabase')"
	COUNT_REPLICATION_SLOTS = "SELECT COUNT(*) FROM pg_replication_slots WHERE database IN ('postgres', '_supabase')"
)

func DisconnectClients(ctx context.Context, conn *pgx.Conn) error {
	// Must be executed separately because looping in transaction is unsupported
	// https://dba.stackexchange.com/a/11895
	disconn := migration.MigrationFile{
		Statements: []string{
			"ALTER DATABASE postgres ALLOW_CONNECTIONS false",
			"ALTER DATABASE _supabase ALLOW_CONNECTIONS false",
			TERMINATE_BACKENDS,
		},
	}
	if err := disconn.ExecBatch(ctx, conn); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code != pgerrcode.InvalidCatalogName {
			return errors.Errorf("failed to disconnect clients: %w", err)
		}
	}
	// Wait for WAL senders to drop their replication slots
	policy := dbstart.NewBackoffPolicy(ctx, 10*time.Second)
	waitForDrop := func() error {
		var count int
		if err := conn.QueryRow(ctx, COUNT_REPLICATION_SLOTS).Scan(&count); err != nil {
			err = errors.Errorf("failed to count replication slots: %w", err)
			return &backoff.PermanentError{Err: err}
		} else if count > 0 {
			return errors.Errorf("replication slots still active: %d", count)
		}
		return nil
	}
	return backoff.Retry(waitForDrop, policy)
}

func RestartDatabase(ctx context.Context, w io.Writer) error {
	fmt.Fprintln(w, "Restarting containers...")
	// Some extensions must be manually restarted after pg_terminate_backend
	// Ref: https://github.com/citusdata/pg_cron/issues/99
	if err := restartContainer(ctx, utils.DbId); err != nil {
		return errors.Errorf("failed to restart container: %w", err)
	}
	if err := waitForHealthyService(ctx, utils.Config.Db.HealthTimeout, utils.DbId); err != nil {
		return err
	}
	return restartServices(ctx)
}

func waitForDatabaseReady(ctx context.Context, timeout time.Duration, options ...func(*pgx.ConnConfig)) error {
	policy := dbstart.NewBackoffPolicy(ctx, timeout)
	return backoff.Retry(func() error {
		conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
		if err != nil {
			return err
		}
		return conn.Close(ctx)
	}, policy)
}

func seedBucketsWithRetry(ctx context.Context, fsys afero.Fs) error {
	policy := dbstart.NewBackoffPolicy(ctx, 30*time.Second)
	return backoff.Retry(func() error {
		return runBucketSeed(ctx, "", false, fsys)
	}, policy)
}

func waitForAPIReady(ctx context.Context, timeout time.Duration) error {
	addr := net.JoinHostPort(utils.Config.Hostname, strconv.FormatUint(uint64(utils.Config.Api.Port), 10))
	policy := dbstart.NewBackoffPolicy(ctx, timeout)
	return backoff.Retry(func() error {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return err
		}
		return conn.Close()
	}, policy)
}

func restartServices(ctx context.Context) error {
	// No need to restart PostgREST because it automatically reconnects and listens for schema changes
	services := listServicesToRestart()
	result := utils.WaitAll(services, func(id string) error {
		if err := restartContainer(ctx, id); err != nil && !errdefs.IsNotFound(err) {
			return errors.Errorf("failed to restart %s: %w", id, err)
		}
		return nil
	})
	// Do not wait for service healthy as those services may be excluded from starting
	return errors.Join(result...)
}

// listServicesToRestart returns containers that need restarting after a
// database reset.  Kong is included because it caches upstream addresses that
// may change when the database container is recreated (especially on Apple
// containers which use dynamic IPs).
func listServicesToRestart() []string {
	return []string{utils.StorageId, utils.GotrueId, utils.RealtimeId, utils.PoolerId, utils.KongId}
}

func resetRemote(ctx context.Context, version string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	msg := "Do you want to reset the remote database?"
	if shouldReset, err := utils.NewConsole().PromptYesNo(ctx, msg, false); err != nil {
		return err
	} else if !shouldReset {
		return errors.New(context.Canceled)
	}
	fmt.Fprintln(os.Stderr, "Resetting remote database"+toLogMessage(version))
	conn, err := utils.ConnectByConfigStream(ctx, config, io.Discard, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return down.ResetAll(ctx, version, conn, fsys)
}

func LikeEscapeSchema(schemas []string) (result []string) {
	// Treat _ as literal, * as any character
	replacer := strings.NewReplacer("_", `\_`, "*", "%")
	for _, sch := range schemas {
		result = append(result, replacer.Replace(sch))
	}
	return result
}
