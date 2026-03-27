package reset

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
	"github.com/supabase/cli/pkg/storage"
)

// saveResetTestState captures and restores all package-level vars that the
// apple-container reset tests override, reducing repetitive save/restore
// boilerplate in individual test cases.
func saveResetTestState(t *testing.T) {
	t.Helper()
	orig := struct {
		runtime              string
		apiEnabled           bool
		assertRunning        func() error
		removeContainer      func(context.Context, string, bool, bool) error
		removeVolume         func(context.Context, string, bool) error
		startContainer       func(context.Context, container.Config, container.HostConfig, network.NetworkingConfig, string) (string, error)
		inspectContainer     func(context.Context, string) (utils.ContainerInfo, error)
		restartContainer     func(context.Context, string) error
		waitForHealthy       func(context.Context, time.Duration, ...string) error
		waitForLocalDB       func(context.Context, time.Duration, ...func(*pgx.ConnConfig)) error
		waitForLocalAPI      func(context.Context, time.Duration) error
		setupLocalDB         func(context.Context, string, afero.Fs, io.Writer, ...func(*pgx.ConnConfig)) error
		restartKongFn        func(context.Context, start.KongDependencies) error
		runBucketSeedFn      func(context.Context, string, bool, afero.Fs) error
		seedBucketsFn        func(context.Context, afero.Fs) error
		dbId, storageId      string
		gotrueId, realtimeId string
		poolerId, kongId     string
	}{
		runtime:          string(utils.Config.Runtime.Backend),
		apiEnabled:       utils.Config.Api.Enabled,
		assertRunning:    assertSupabaseDbIsRunning,
		removeContainer:  removeContainer,
		removeVolume:     removeVolume,
		startContainer:   startContainer,
		inspectContainer: inspectContainer,
		restartContainer: restartContainer,
		waitForHealthy:   waitForHealthyService,
		waitForLocalDB:   waitForLocalDatabase,
		waitForLocalAPI:  waitForLocalAPI,
		setupLocalDB:     setupLocalDatabase,
		restartKongFn:    restartKong,
		runBucketSeedFn:  runBucketSeed,
		seedBucketsFn:    seedBuckets,
		dbId:             utils.DbId,
		storageId:        utils.StorageId,
		gotrueId:         utils.GotrueId,
		realtimeId:       utils.RealtimeId,
		poolerId:         utils.PoolerId,
		kongId:           utils.KongId,
	}
	t.Cleanup(func() {
		utils.Config.Runtime.Backend = config.LocalRuntime(orig.runtime)
		utils.Config.Api.Enabled = orig.apiEnabled
		assertSupabaseDbIsRunning = orig.assertRunning
		removeContainer = orig.removeContainer
		removeVolume = orig.removeVolume
		startContainer = orig.startContainer
		inspectContainer = orig.inspectContainer
		restartContainer = orig.restartContainer
		waitForHealthyService = orig.waitForHealthy
		waitForLocalDatabase = orig.waitForLocalDB
		waitForLocalAPI = orig.waitForLocalAPI
		setupLocalDatabase = orig.setupLocalDB
		restartKong = orig.restartKongFn
		runBucketSeed = orig.runBucketSeedFn
		seedBuckets = orig.seedBucketsFn
		utils.DbId = orig.dbId
		utils.StorageId = orig.storageId
		utils.GotrueId = orig.gotrueId
		utils.RealtimeId = orig.realtimeId
		utils.PoolerId = orig.poolerId
		utils.KongId = orig.kongId
	})
}

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
		originalWaitForLocalDatabase := waitForLocalDatabase
		t.Cleanup(func() {
			waitForLocalDatabase = originalWaitForLocalDatabase
		})
		waitForLocalDatabase = func(context.Context, time.Duration, ...func(*pgx.ConnConfig)) error {
			return nil
		}

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
		utils.KongId = "test-kong"
		for _, container := range listServicesToRestart() {
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/" + container + "/restart").
				Reply(http.StatusOK)
		}
		// Seeds storage
		gock.New(utils.Docker.DaemonHost()).
			Persist().
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

	t.Run("uses runtime helpers on apple container runtime", func(t *testing.T) {
		saveResetTestState(t)

		utils.Config.Runtime.Backend = "apple-container"
		utils.Config.Db.MajorVersion = 15
		utils.Config.Api.Enabled = true
		utils.DbId = "test-reset"
		utils.StorageId = "test-storage"
		utils.GotrueId = "test-auth"
		utils.RealtimeId = "test-realtime"
		utils.PoolerId = "test-pooler"
		utils.KongId = "test-kong"

		fsys := afero.NewMemMapFs()

		var removedContainers []string
		var removedVolumes []string
		var startedContainers []string
		var restartedContainers []string
		var waited []string
		var mu sync.Mutex
		restartedKong := false
		bucketSeeded := false

		assertSupabaseDbIsRunning = func() error { return nil }
		removeContainer = func(_ context.Context, containerID string, removeVolumes, force bool) error {
			assert.True(t, removeVolumes)
			assert.True(t, force)
			removedContainers = append(removedContainers, containerID)
			return nil
		}
		removeVolume = func(_ context.Context, volumeName string, force bool) error {
			assert.True(t, force)
			removedVolumes = append(removedVolumes, volumeName)
			return nil
		}
		startContainer = func(_ context.Context, _ container.Config, _ container.HostConfig, _ network.NetworkingConfig, containerName string) (string, error) {
			startedContainers = append(startedContainers, containerName)
			return containerName, nil
		}
		inspectContainer = func(_ context.Context, containerID string) (utils.ContainerInfo, error) {
			if containerID == utils.StorageId || containerID == utils.KongId {
				return utils.ContainerInfo{ID: containerID, Running: true}, nil
			}
			return utils.ContainerInfo{}, errors.New("unexpected inspect")
		}
		restartContainer = func(_ context.Context, containerID string) error {
			mu.Lock()
			restartedContainers = append(restartedContainers, containerID)
			mu.Unlock()
			return nil
		}
		waitForHealthyService = func(_ context.Context, _ time.Duration, started ...string) error {
			waited = append(waited, started...)
			return nil
		}
		waitForLocalDatabase = func(_ context.Context, _ time.Duration, _ ...func(*pgx.ConnConfig)) error {
			return nil
		}
		waitForLocalAPI = func(_ context.Context, _ time.Duration) error {
			return nil
		}
		setupLocalDatabase = func(_ context.Context, version string, _ afero.Fs, _ io.Writer, _ ...func(*pgx.ConnConfig)) error {
			assert.Empty(t, version)
			return nil
		}
		restartKong = func(_ context.Context, deps start.KongDependencies) error {
			_ = deps
			restartedKong = true
			return nil
		}
		runBucketSeed = func(_ context.Context, _ string, _ bool, _ afero.Fs) error {
			bucketSeeded = true
			return nil
		}

		err := Run(context.Background(), "", 0, dbConfig, fsys)

		require.NoError(t, err)
		assert.Equal(t, []string{utils.DbId}, removedContainers)
		assert.Equal(t, []string{utils.DbId}, removedVolumes)
		assert.Equal(t, []string{utils.DbId}, startedContainers)
		assert.True(t, bucketSeeded)
		assert.True(t, restartedKong)
		assert.True(t, slices.Contains(waited, utils.DbId))
		assert.ElementsMatch(t, []string{utils.StorageId, utils.GotrueId, utils.RealtimeId, utils.PoolerId, utils.KongId}, restartedContainers)
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
			Reply("SELECT 1", []any{0}).
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
			Reply("SELECT 1", []any{0}).
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
		utils.KongId = "test-kong"
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
		utils.KongId = "test-kong"
		for _, container := range []string{utils.StorageId, utils.GotrueId, utils.RealtimeId} {
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/" + container + "/restart").
				Reply(http.StatusServiceUnavailable)
		}
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.PoolerId + "/restart").
			Reply(http.StatusNotFound)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.KongId + "/restart").
			Reply(http.StatusOK)
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
