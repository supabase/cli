package test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "db.supabase.co",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRunCommand(t *testing.T) {
	t.Run("runs tests with pg_prove", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			Reply("CREATE EXTENSION").
			Query(DISABLE_PGTAP).
			Reply("DROP EXTENSION")
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		containerId := "test-pg-prove"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(config.Images.PgProve), containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "Result: SUCCESS"))
		// Run test
		err := Run(context.Background(), []string{"nested"}, dbConfig, false, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("runs tests with pg_prove using shadow db", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		utils.Config.Db.ShadowPort = 54320
		utils.Config.Db.HealthTimeout = 10 * time.Second
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres - two connections needed:
		// conn1: MigrateShadowDatabase (GlobalsSql, InitialSchemaPg14Sql, CREATE_TEMPLATE)
		// conn2: Run main path (ENABLE_PGTAP, DISABLE_PGTAP)
		conn1 := pgtest.NewConn()
		defer conn1.Close(t)
		conn1.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA").
			Query(diff.CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		conn2 := pgtest.NewConn()
		defer conn2.Close(t)
		conn2.Query(ENABLE_PGTAP).
			Reply("CREATE EXTENSION").
			Query(DISABLE_PGTAP).
			Reply("DROP EXTENSION")
		// Interceptor routes by call order
		called := false
		interceptor := func(cc *pgx.ConnConfig) {
			if !called {
				called = true
				conn1.Intercept(cc)
			} else {
				conn2.Intercept(cc)
			}
		}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		shadowId := "test-shadow-db"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), shadowId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + shadowId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + shadowId).
			Reply(http.StatusOK)
		pgProveId := "test-pg-prove"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(config.Images.PgProve), pgProveId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, pgProveId, "Result: SUCCESS"))
		// Run test
		err := Run(context.Background(), []string{"nested"}, dbConfig, true, fsys, interceptor)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on shadow db creation failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil, dbConfig, true, fsys)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on shadow db migration failure", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		utils.Config.Db.ShadowPort = 54320
		utils.Config.Db.HealthTimeout = 10 * time.Second
		utils.GlobalsSql = "create schema public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		shadowId := "test-shadow-db"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), shadowId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + shadowId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + shadowId).
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), nil, dbConfig, true, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := Run(context.Background(), nil, dbConfig, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to connect to postgres")
	})

	t.Run("throws error on pgtap failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			ReplyError(pgerrcode.DuplicateObject, `extension "pgtap" already exists, skipping`)
		// Run test
		err := Run(context.Background(), nil, dbConfig, false, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "failed to enable pgTAP")
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ENABLE_PGTAP).
			Reply("CREATE EXTENSION").
			Query(DISABLE_PGTAP).
			Reply("DROP EXTENSION")
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(config.Images.PgProve) + "/json").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil, dbConfig, false, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
