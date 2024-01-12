package diff

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/history"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     "db.supabase.co",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRunMigra(t *testing.T) {
	t.Run("runs migra diff", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg15Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), "test-shadow-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StorageImage), "test-shadow-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.MigraImage), "test-migra")
		diff := "create table test();"
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-migra", diff))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "file", dbConfig, fsys, conn.Intercept)
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

	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "", pgconn.Config{}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on failure to load user schemas", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(strings.ReplaceAll(reset.LIST_SCHEMAS, "$1", `'{auth,pgbouncer,realtime,"\\_realtime",storage,"\\_analytics","supabase\\_functions","supabase\\_migrations","information\\_schema","pg\\_%",cron,graphql,"graphql\\_public",net,pgsodium,"pgsodium\\_masks",pgtle,repack,tiger,"tiger\\_data","timescaledb\\_%","\\_timescaledb\\_%",topology,vault}'`)).
			ReplyError(pgerrcode.DuplicateTable, `relation "test" already exists`)
		// Run test
		err := RunMigra(context.Background(), []string{}, "", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "test" already exists (SQLSTATE 42P07)`)
	})

	t.Run("throws error on failure to diff target", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Pg15Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "file", dbConfig, fsys)
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
		utils.InitialSchemaSql = "create schema private"
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
			Query(utils.InitialSchemaSql).
			Reply("CREATE SCHEMA").
			Query(sql).
			Reply("CREATE SCHEMA")
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.INSERT_MIGRATION_VERSION, "0", "test", fmt.Sprintf("{%s}", sql)).
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
		assert.ErrorContains(t, err, "operation was canceled")
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
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
	utils.Config.Db.Image = utils.Pg14Image
	utils.Config.Db.ShadowPort = 54320
	utils.GlobalsSql = "create schema public"
	utils.InitialSchemaSql = "create schema private"

	t.Run("throws error on failure to create shadow", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Pg14Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys)
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg14Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusServiceUnavailable)
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorIs(t, err, start.ErrDatabase)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to migrate shadow", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg14Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
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
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, conn.Intercept)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)
At statement 0: create schema public`)
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg14Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.MigraImage), "test-migra")
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
			Query(utils.InitialSchemaSql).
			Reply("CREATE SCHEMA").
			Query(sql).
			Reply("CREATE SCHEMA")
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.INSERT_MIGRATION_VERSION, "0", "test", fmt.Sprintf("{%s}", sql)).
			Reply("INSERT 0 1")
		// Run test
		diff, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, conn.Intercept)
		// Check error
		assert.Empty(t, diff)
		assert.ErrorContains(t, err, "error diffing schema")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestUserSchema(t *testing.T) {
	// Setup mock postgres
	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query(strings.ReplaceAll(reset.LIST_SCHEMAS, "$1", `'{auth,pgbouncer,realtime,"\\_realtime",storage,"\\_analytics","supabase\\_functions","supabase\\_migrations","information\\_schema","pg\\_%",cron,graphql,"graphql\\_public",net,pgsodium,"pgsodium\\_masks",pgtle,repack,tiger,"tiger\\_data","timescaledb\\_%","\\_timescaledb\\_%",topology,vault}'`)).
		Reply("SELECT 1", []interface{}{"test"})
	// Connect to mock
	ctx := context.Background()
	mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
	require.NoError(t, err)
	defer mock.Close(ctx)
	// Run test
	schemas, err := LoadUserSchemas(ctx, mock)
	// Check error
	assert.NoError(t, err)
	assert.ElementsMatch(t, []string{"test"}, schemas)
}

func TestDropStatements(t *testing.T) {
	drops := findDropStatements("create table t(); drop table t; alter table t drop column c")
	assert.Equal(t, []string{"drop table t", "alter table t drop column c"}, drops)
}
