package reset

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgtest"
	"github.com/supabase/cli/pkg/storage"
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

	t.Run("seeds storage after reset", func(t *testing.T) {
		utils.DbId = "test-reset"
		utils.ConfigId = "test-config"
		utils.Config.Db.MajorVersion = 15
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
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
		// Seeds storage
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.StorageId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		// Run test
		err := Run(context.Background(), "", 0, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on context canceled", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", 0, pgconn.Config{Host: "db.supabase.co"}, fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", 0, pgconn.Config{Host: "db.supabase.co"}, fsys)
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
		err := Run(context.Background(), "", 0, dbConfig, fsys)
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
			JSON(container.InspectResponse{})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "", 0, dbConfig, fsys)
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
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false").
			Reply("ALTER DATABASE").
			Query("ALTER DATABASE _supabase ALLOW_CONNECTIONS false").
			Reply("ALTER DATABASE").
			Query(TERMINATE_BACKENDS).
			Reply("SELECT 1").
			Query(COUNT_REPLICATION_SLOTS).
			Reply("SELECT 1", []interface{}{0}).
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE)").
			Reply("DROP DATABASE").
			Query("CREATE DATABASE postgres WITH OWNER postgres").
			Reply("CREATE DATABASE").
			Query("DROP DATABASE IF EXISTS _supabase WITH (FORCE)").
			Reply("DROP DATABASE").
			Query("CREATE DATABASE _supabase WITH OWNER postgres").
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
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false").
			Reply("ALTER DATABASE").
			Query("ALTER DATABASE _supabase ALLOW_CONNECTIONS false").
			ReplyError(pgerrcode.InvalidCatalogName, `database "_supabase" does not exist`).
			Query(TERMINATE_BACKENDS).
			Query(COUNT_REPLICATION_SLOTS).
			ReplyError(pgerrcode.UndefinedTable, `relation "pg_replication_slots" does not exist`)
		// Run test
		err := recreateDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "pg_replication_slots" does not exist (SQLSTATE 42P01)`)
	})

	t.Run("throws error on failure to disconnect", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false").
			ReplyError(pgerrcode.InvalidParameterValue, `cannot disallow connections for current database`).
			Query("ALTER DATABASE _supabase ALLOW_CONNECTIONS false").
			Query(TERMINATE_BACKENDS)
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
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false").
			Reply("ALTER DATABASE").
			Query("ALTER DATABASE _supabase ALLOW_CONNECTIONS false").
			Reply("ALTER DATABASE").
			Query(TERMINATE_BACKENDS).
			Reply("SELECT 1").
			Query(COUNT_REPLICATION_SLOTS).
			Reply("SELECT 1", []interface{}{0}).
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE)").
			ReplyError(pgerrcode.ObjectInUse, `database "postgres" is used by an active logical replication slot`).
			Query("CREATE DATABASE postgres WITH OWNER postgres").
			Query("DROP DATABASE IF EXISTS _supabase WITH (FORCE)").
			Reply("DROP DATABASE").
			Query("CREATE DATABASE _supabase WITH OWNER postgres").
			Reply("CREATE DATABASE")
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
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
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
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
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
		assert.ErrorContains(t, err, "failed to restart "+utils.StorageId)
		assert.ErrorContains(t, err, "failed to restart "+utils.GotrueId)
		assert.ErrorContains(t, err, "failed to restart "+utils.RealtimeId)
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
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
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
