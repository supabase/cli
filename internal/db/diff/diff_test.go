package diff

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "db.supabase.co",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRun(t *testing.T) {
	t.Run("runs migra diff", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, flags.LoadConfig(fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-shadow-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-shadow-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-shadow-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(config.Images.Migra), "test-migra")
		diff := "create table test();"
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-migra", diff))
		// Setup mock postgres
		conn := pgtest.NewConn()
		conn.Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		defer conn.Close(t)
		// Run test
		err := Run(context.Background(), []string{"public"}, "file", dbConfig, DiffSchemaMigra, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check diff file
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.Equal(t, 1, len(files))
		diffPath := filepath.Join(utils.MigrationsDir, files[0].Name())
		contents, err := afero.ReadFile(fsys, diffPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(diff), contents)
	})

	t.Run("throws error on failure to diff target", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), []string{"public"}, "file", dbConfig, DiffSchemaMigra, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestMigrateShadow(t *testing.T) {
	utils.Config.Db.MajorVersion = 14

	t.Run("migrates shadow database", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA").
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{sql}).
			Reply("INSERT 0 1")
		// Run test
		err := MigrateShadowDatabase(context.Background(), "test-shadow-db", fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on timeout", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup cancelled context
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		// Run test
		err := MigrateShadowDatabase(ctx, "", fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Run test
		err := MigrateShadowDatabase(context.Background(), "", fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on globals schema", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		utils.GlobalsSql = "create schema public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := MigrateShadowDatabase(context.Background(), "test-shadow-db", fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
	})
}

func TestDiffDatabase(t *testing.T) {
	utils.Config.Db.MajorVersion = 14
	utils.Config.Db.ShadowPort = 54320
	utils.GlobalsSql = "create schema public"
	utils.InitialSchemaPg14Sql = "create schema private"

	t.Run("throws error on failure to create shadow", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on health check failure", func(t *testing.T) {
		start.HealthTimeout = time.Millisecond
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: false,
					Status:  "exited",
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/logs").
			Reply(http.StatusServiceUnavailable)
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, "test-shadow-db container is not running: exited")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to migrate shadow", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, conn.Intercept)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)
At statement: 0
create schema public`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to diff target", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(config.Images.Migra), "test-migra")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-migra/logs").
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-migra").
			Reply(http.StatusOK)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA").
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{sql}).
			Reply("INSERT 0 1")
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, conn.Intercept)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, "error diffing schema")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDropStatements(t *testing.T) {
	drops := findDropStatements("create table t(); drop table t; alter table t drop column c")
	assert.Equal(t, []string{"drop table t", "alter table t drop column c"}, drops)
}

func TestLoadSchemas(t *testing.T) {
	expected := []string{
		filepath.Join(utils.SchemasDir, "comment", "model.sql"),
		filepath.Join(utils.SchemasDir, "model.sql"),
		filepath.Join(utils.SchemasDir, "reaction", "dislike", "model.sql"),
		filepath.Join(utils.SchemasDir, "reaction", "like", "model.sql"),
	}
	fsys := afero.NewMemMapFs()
	for _, fp := range expected {
		require.NoError(t, afero.WriteFile(fsys, fp, nil, 0644))
	}
	// Run test
	schemas, err := loadDeclaredSchemas(fsys)
	// Check error
	assert.NoError(t, err)
	assert.ElementsMatch(t, expected, schemas)
}
