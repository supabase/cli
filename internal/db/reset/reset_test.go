package reset

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestResetCommand(t *testing.T) {
	const version = "1.41"

	t.Run("throws error on missing config", func(t *testing.T) {
		err := Run(context.Background(), afero.NewMemMapFs())
		assert.ErrorContains(t, err, "Missing config: open supabase/config.toml: file does not exist")
	})

	t.Run("throws error on db is not started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "supabase start is not running.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to recreate", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidParameterValue, `cannot disallow connections for current database`)
		// Run test
		err := Run(context.Background(), fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: cannot disallow connections for current database (SQLSTATE 22023)")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestResetDatabase(t *testing.T) {
	t.Run("initialises postgres database", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		utils.InitialSchemaSql = "CREATE SCHEMA public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.InitialSchemaSql).
			Reply("CREATE SCHEMA")
		// Run test
		assert.NoError(t, resetDatabase(context.Background(), fsys, conn.Intercept))
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		utils.Config.Db.Port = 0
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := resetDatabase(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port")
	})

	t.Run("throws error on duplicate schema", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		utils.InitialSchemaSql = "CREATE SCHEMA public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.InitialSchemaSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := resetDatabase(context.Background(), fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
	})

	t.Run("throws error on migration failure", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		utils.InitialSchemaSql = "CREATE SCHEMA public"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_table.sql")
		sql := "CREATE TABLE example()"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.InitialSchemaSql).
			Reply("CREATE SCHEMA").
			Query(sql).
			ReplyError(pgerrcode.DuplicateObject, `table "example" already exists`)
		// Run test
		err := resetDatabase(context.Background(), fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: table "example" already exists (SQLSTATE 42710)`)
	})
}

func TestSeedDatabase(t *testing.T) {
	t.Run("seeds from file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.SeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, "localhost", 54322, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		assert.NoError(t, SeedDatabase(ctx, mock, fsys))
	})

	t.Run("ignores missing seed", func(t *testing.T) {
		assert.NoError(t, SeedDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.SeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "age" of relation "employees"`)
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, "localhost", 54322, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = SeedDatabase(ctx, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "age" of relation "employees" (SQLSTATE 23502)`)
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
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE);").
			Reply("DROP DATABASE").
			Query("CREATE DATABASE postgres;").
			Reply("CREATE DATABASE")
		// Run test
		assert.NoError(t, RecreateDatabase(context.Background(), conn.Intercept))
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		utils.Config.Db.Port = 0
		assert.ErrorContains(t, RecreateDatabase(context.Background()), "invalid port")
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
		err := RecreateDatabase(context.Background(), conn.Intercept)
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
		err := RecreateDatabase(context.Background(), conn.Intercept)
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
			Query("DROP DATABASE IF EXISTS postgres WITH (FORCE);").
			ReplyError(pgerrcode.ObjectInUse, `database "postgres" is used by an active logical replication slot`)
		// Run test
		err := RecreateDatabase(context.Background(), conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" is used by an active logical replication slot (SQLSTATE 55006)`)
	})
}

func TestRestartDatabase(t *testing.T) {
	const version = "1.41"

	t.Run("restarts storage api", func(t *testing.T) {
		utils.DbId = "test-reset"
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusOK)
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		utils.StorageId = "test-storage"
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + utils.StorageId + "/restart").
			Reply(http.StatusServiceUnavailable)
		// Run test
		RestartDatabase(context.Background())
		// Check error
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("timeout health check", func(t *testing.T) {
		utils.DbId = "test-reset"
		healthTimeout = 0 * time.Second
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + utils.DbId + "/restart").
			Reply(http.StatusOK)
		// Run test
		RestartDatabase(context.Background())
		// Check error
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
