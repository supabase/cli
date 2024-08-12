package reset

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestResetCommand(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	var dbConfig = pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "admin",
		Password: "password",
		Database: "postgres",
	}

	t.Run("throws error on context canceled", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", pgconn.Config{Host: "db.supabase.co"}, fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", pgconn.Config{Host: "db.supabase.co"}, fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on db is not started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), "", dbConfig, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotRunning)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to recreate", func(t *testing.T) {
		utils.DbId = "test-reset"
		utils.Config.Db.MajorVersion = 15
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "", dbConfig, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestInitDatabase(t *testing.T) {
	t.Run("initializes postgres database", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA")
		// Run test
		assert.NoError(t, initDatabase(context.Background(), conn.Intercept))
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.Config.Db.Port = 0
		// Run test
		err := initDatabase(context.Background())
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on duplicate schema", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.InitialSchemaPg14Sql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := initDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
	})
}

func TestRecreateDatabase(t *testing.T) {
	t.Run("resets postgres database", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			Reply("ALTER DATABASE").
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			Reply("DO").
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE)").
			Reply("DROP DATABASE").
			Query("CREATE DATABASE postgres WITH OWNER postgres").
			Reply("CREATE DATABASE")
		// Run test
		assert.NoError(t, recreateDatabase(context.Background(), conn.Intercept))
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		utils.Config.Db.Port = 0
		assert.ErrorContains(t, recreateDatabase(context.Background()), "invalid port")
	})

	t.Run("continues on disconnecting missing database", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidCatalogName, `database "postgres" does not exist`).
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			ReplyError(pgerrcode.UndefinedTable, `relation "pg_stat_activity" does not exist`)
		// Run test
		err := recreateDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "pg_stat_activity" does not exist (SQLSTATE 42P01)`)
	})

	t.Run("throws error on failure to disconnect", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidParameterValue, `cannot disallow connections for current database`)
		// Run test
		err := recreateDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: cannot disallow connections for current database (SQLSTATE 22023)")
	})

	t.Run("throws error on failure to drop", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			Reply("ALTER DATABASE").
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			Reply("DO").
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE)").
			ReplyError(pgerrcode.ObjectInUse, `database "postgres" is used by an active logical replication slot`).
			Query("CREATE DATABASE postgres WITH OWNER postgres")
		// Run test
		err := recreateDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" is used by an active logical replication slot (SQLSTATE 55006)`)
	})
}

func TestRestartDatabase(t *testing.T) {
	t.Run("restarts affected services", func(t *testing.T) {
		utils.DbId = "test-reset"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Restarts postgres
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		// Restarts services
		utils.StorageId = "test-storage"
		utils.GotrueId = "test-auth"
		utils.RealtimeId = "test-realtime"
		utils.PoolerId = "test-pooler"
		for _, container := range listServicesToRestart() {
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/" + container + "/restart").
				Reply(http.StatusOK)
		}
		// Run test
		err := RestartDatabase(context.Background(), io.Discard)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service restart failure", func(t *testing.T) {
		utils.DbId = "test-reset"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Restarts postgres
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		// Restarts services
		utils.StorageId = "test-storage"
		utils.GotrueId = "test-auth"
		utils.RealtimeId = "test-realtime"
		utils.PoolerId = "test-pooler"
		for _, container := range []string{utils.StorageId, utils.GotrueId, utils.RealtimeId} {
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/" + container + "/restart").
				Reply(http.StatusServiceUnavailable)
		}
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.PoolerId + "/restart").
			Reply(http.StatusNotFound)
		// Run test
		err := RestartDatabase(context.Background(), io.Discard)
		// Check error
		assert.ErrorContains(t, err, "Failed to restart "+utils.StorageId)
		assert.ErrorContains(t, err, "Failed to restart "+utils.GotrueId)
		assert.ErrorContains(t, err, "Failed to restart "+utils.RealtimeId)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on db restart failure", func(t *testing.T) {
		utils.DbId = "test-reset"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Restarts postgres
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RestartDatabase(context.Background(), io.Discard)
		// Check error
		assert.ErrorContains(t, err, "failed to restart container")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on health check timeout", func(t *testing.T) {
		utils.DbId = "test-reset"
		start.HealthTimeout = 0 * time.Second
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/test-reset/restart").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-reset/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: false,
					Status:  "exited",
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-reset/logs").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := RestartDatabase(context.Background(), io.Discard)
		// Check error
		assert.ErrorContains(t, err, "test-reset container is not running: exited")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

var escapedSchemas = append(migration.ManagedSchemas, "extensions", "public")

func TestResetRemote(t *testing.T) {
	dbConfig := pgconn.Config{
		Host:     "db.supabase.co",
		Port:     5432,
		User:     "admin",
		Password: "password",
		Database: "postgres",
	}

	t.Run("resets remote database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_schema.sql")
		require.NoError(t, afero.WriteFile(fsys, path, nil, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.ListSchemas, escapedSchemas).
			Reply("SELECT 1", []interface{}{"private"}).
			Query("DROP SCHEMA IF EXISTS private CASCADE").
			Reply("DROP SCHEMA").
			Query(migration.DropObjects).
			Reply("INSERT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "schema", nil).
			Reply("INSERT 0 1")
		// Run test
		err := resetRemote(context.Background(), "", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := resetRemote(context.Background(), "", pgconn.Config{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on drop schema failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.ListSchemas, escapedSchemas).
			Reply("SELECT 0").
			Query(migration.DropObjects).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := resetRemote(context.Background(), "", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}
