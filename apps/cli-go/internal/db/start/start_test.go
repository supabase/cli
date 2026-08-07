package start

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"testing"
	stdfs "testing/fstest"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/volume"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
)

func mockTransactionalStatement(conn *pgtest.MockConn, statement, reply string) *pgtest.MockConn {
	return conn.Query("BEGIN").
		Reply("BEGIN").
		Query(statement).
		Reply(reply).
		Query("COMMIT").
		Reply("COMMIT")
}

func TestInitBranch(t *testing.T) {
	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on stat failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.StatErrorFs{DenyPath: utils.CurrBranchPath}
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.CurrBranchPath}
		// Run test
		err := initCurrentBranch(fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}

func TestStartDatabase(t *testing.T) {
	t.Run("initialize main branch", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		roles := "create role test"
		require.NoError(t, afero.WriteFile(fsys, utils.CustomRolesPath, []byte(roles), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound).
			JSON(volume.Volume{})
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Setup mock postgres: with auto_expose_new_tables unset, the implicit default revokes
		// the default Data API GRANTs before seeding roles.
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockApiPrivilegesRevoke(conn)
		mockTransactionalStatement(conn, roles, "CREATE ROLE")
		// Run test
		err := StartDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check current branch
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("main"), contents)
	})

	t.Run("recover from backup volume", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(volume.Volume{})
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
		// Run test
		err := StartDatabase(context.Background(), "", fsys, io.Discard)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check current branch
		contents, err := afero.ReadFile(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("main"), contents)
	})

	t.Run("throws error on start failure", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := StartDatabase(context.Background(), "", fsys, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "request returned 503 Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestStartCommand(t *testing.T) {
	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), "", fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("exits if already started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		// Run test
		err := Run(context.Background(), "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on start failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/").
			Reply(http.StatusNotFound)
		// Fail to start
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/").
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Cleanup resources
		apitest.MockDockerStop(utils.Docker)
		// Run test
		err := Run(context.Background(), "", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSetupDatabase(t *testing.T) {
	utils.Config.Db.MajorVersion = 15

	t.Run("revokes default data api privileges when auto_expose_new_tables is unset", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		utils.Config.Api.AutoExposeNewTables = nil
		defer func() {
			utils.Config.Db.MajorVersion = 15
		}()
		utils.Config.Db.Port = 5432
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		roles := "create role postgres"
		require.NoError(t, afero.WriteFile(fsys, utils.CustomRolesPath, []byte(roles), 0644))
		// Setup mock postgres: with the flag unset, the implicit default now revokes the
		// default Data API GRANTs (the May 30 2026 flip) between initial schema and roles.sql
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockTransactionalStatement(conn, utils.GlobalsSql, "CREATE SCHEMA")
		mockTransactionalStatement(conn, utils.InitialSchemaPg14Sql, "CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(conn)
		mockTransactionalStatement(conn, roles, "CREATE ROLE")
		// Run test
		err := SetupLocalDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("keeps default data api privileges when auto_expose_new_tables is true", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		flag := true
		utils.Config.Api.AutoExposeNewTables = &flag
		defer func() {
			utils.Config.Db.MajorVersion = 15
			utils.Config.Api.AutoExposeNewTables = nil
		}()
		utils.Config.Db.Port = 5432
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		roles := "create role postgres"
		require.NoError(t, afero.WriteFile(fsys, utils.CustomRolesPath, []byte(roles), 0644))
		// Setup mock postgres: explicit true opts into the legacy behaviour, so no revoke SQL
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockTransactionalStatement(conn, utils.GlobalsSql, "CREATE SCHEMA")
		mockTransactionalStatement(conn, utils.InitialSchemaPg14Sql, "CREATE SCHEMA")
		mockTransactionalStatement(conn, roles, "CREATE ROLE")
		// Run test
		err := SetupLocalDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("revokes default data api privileges when auto_expose_new_tables is false", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		flag := false
		utils.Config.Api.AutoExposeNewTables = &flag
		defer func() {
			utils.Config.Db.MajorVersion = 15
			utils.Config.Api.AutoExposeNewTables = nil
		}()
		utils.Config.Db.Port = 5432
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		roles := "create role postgres"
		require.NoError(t, afero.WriteFile(fsys, utils.CustomRolesPath, []byte(roles), 0644))
		// Setup mock postgres: the revoke SQL must execute between the initial schema and roles.sql
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockTransactionalStatement(conn, utils.GlobalsSql, "CREATE SCHEMA")
		mockTransactionalStatement(conn, utils.InitialSchemaPg14Sql, "CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(conn)
		mockTransactionalStatement(conn, roles, "CREATE ROLE")
		// Run test
		err := SetupLocalDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.Config.Db.Port = 0
		// Run test
		err := SetupLocalDatabase(context.Background(), "", nil, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on init failure", func(t *testing.T) {
		utils.Config.Realtime.Enabled = true
		utils.Config.Db.Port = 5432
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Realtime.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := SetupLocalDatabase(context.Background(), "", nil, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		utils.Config.Db.Port = 5432
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.CustomRolesPath}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Setup mock postgres: the default-privilege revoke runs before roles.sql is read
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockApiPrivilegesRevoke(conn)
		// Run test
		err := SetupLocalDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestApplyDatabaseWebhooks(t *testing.T) {
	originalConfig := utils.Config
	t.Cleanup(func() { utils.Config = originalConfig })

	t.Run("does not install pg_net merely because Edge Runtime is enabled", func(t *testing.T) {
		cfg := config.NewConfig()
		cfg.EdgeRuntime.Enabled = true
		utils.Config = cfg
		conn := pgtest.NewConn()
		defer conn.Close(t)

		require.NoError(t, ApplyDatabaseWebhooks(context.Background(), conn.MockClient(t)))
	})

	t.Run("installs pg_net when Database Webhooks is enabled even without Edge Runtime", func(t *testing.T) {
		cfg := config.NewConfig()
		require.NoError(t, cfg.Load("config.toml", stdfs.MapFS{
			"config.toml": &stdfs.MapFile{Data: []byte("[experimental.webhooks]\nenabled = true\n")},
		}))
		cfg.EdgeRuntime.Enabled = false
		utils.Config = cfg
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockTransactionalStatement(conn, "create extension if not exists pg_net schema extensions", "CREATE EXTENSION")

		require.NoError(t, ApplyDatabaseWebhooks(context.Background(), conn.MockClient(t)))
	})
}

func TestSetupDatabaseUserExtensionActivation(t *testing.T) {
	originalConfig := utils.Config
	t.Cleanup(func() { utils.Config = originalConfig })

	newWebhookConfig := func(t *testing.T) {
		t.Helper()
		cfg := config.NewConfig()
		require.NoError(t, cfg.Load("config.toml", stdfs.MapFS{
			"config.toml": &stdfs.MapFile{Data: []byte("[experimental.webhooks]\nenabled = true\n")},
		}))
		cfg.Db.MajorVersion = 17
		cfg.Realtime.Enabled = false
		cfg.Storage.Enabled = false
		cfg.Auth.Enabled = false
		utils.Config = cfg
	}

	t.Run("installs pg_net by default when Database Webhooks is enabled", func(t *testing.T) {
		newWebhookConfig(t)
		conn := pgtest.NewConn()
		defer conn.Close(t)
		mockTransactionalStatement(conn, "create extension if not exists pg_net schema extensions", "CREATE EXTENSION")
		helper.MockApiPrivilegesRevoke(conn)

		err := SetupDatabase(context.Background(), conn.MockClient(t), "postgres-host", io.Discard, afero.NewMemMapFs())

		require.NoError(t, err)
	})

	t.Run("can leave user extension activation to declarative SQL", func(t *testing.T) {
		newWebhookConfig(t)
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockApiPrivilegesRevoke(conn)

		err := SetupDatabase(
			context.Background(),
			conn.MockClient(t),
			"postgres-host",
			io.Discard,
			afero.NewMemMapFs(),
			WithoutUserExtensionActivation(),
		)

		require.NoError(t, err)
	})
}

func TestStartDatabaseWithCustomSettings(t *testing.T) {
	t.Run("starts database with custom MaxConnections", func(t *testing.T) {
		// Setup
		utils.Config.Db.MajorVersion = 15
		utils.DbId = "supabase_db_test"
		utils.Config.Db.Port = 5432
		utils.Config.Db.Settings.MaxConnections = cast.Ptr(uint(50))

		// Setup in-memory fs
		fsys := afero.NewMemMapFs()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound).
			JSON(volume.Volume{})
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

		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Setup mock postgres: with auto_expose_new_tables unset, the default Data API GRANTs
		// are revoked by default.
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockApiPrivilegesRevoke(conn)

		// Run test
		err := StartDatabase(context.Background(), "", fsys, io.Discard, conn.Intercept)

		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())

		// Check if the custom MaxConnections setting was applied
		config := NewContainerConfig()
		assert.Contains(t, config.Entrypoint[2], "max_connections = 50")
	})
}
