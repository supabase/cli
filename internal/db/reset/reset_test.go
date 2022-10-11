package reset

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
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
		assert.Error(t, Run(context.Background(), afero.NewMemMapFs()))
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
		assert.Error(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to exec", func(t *testing.T) {
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
			Reply(200).
			JSON(types.ContainerJSON{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSeedDatabase(t *testing.T) {
	const postgresUrl = "postgresql://postgres:password@localhost:5432/postgres"

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
		// Run test
		assert.NoError(t, SeedDatabase(context.Background(), postgresUrl, fsys, conn.Intercept))
	})

	t.Run("throws error on missing seed", func(t *testing.T) {
		// Run test
		err := SeedDatabase(context.Background(), postgresUrl, afero.NewMemMapFs())
		// Check error
		if assert.Error(t, err) {
			assert.True(t, errors.Is(err, os.ErrNotExist))
		}
	})

	t.Run("throws error on malformed url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		_, err := fsys.Create(utils.SeedDataPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, SeedDatabase(context.Background(), "malformed", fsys))
	})

	t.Run("throws error on postgres", func(t *testing.T) {
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
		// Run test
		assert.Error(t, SeedDatabase(context.Background(), postgresUrl, fsys, conn.Intercept))
	})
}

func TestActivateDatabase(t *testing.T) {
	const branch = "main"

	t.Run("activates main branch", func(t *testing.T) {
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
			Query("ALTER DATABASE " + branch + " RENAME TO postgres;").
			Reply("ALTER DATABASE")
		// Run test
		assert.NoError(t, ActivateDatabase(context.Background(), branch, conn.Intercept))
	})

	t.Run("continues on missing database", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidCatalogName, `database "postgres" does not exist`).
			Query(fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres")).
			ReplyError(pgerrcode.UndefinedTable, `relation "pg_stat_activity" does not exist`)
		// Run test
		assert.Error(t, ActivateDatabase(context.Background(), branch, conn.Intercept))
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		// Default port 0
		assert.Error(t, ActivateDatabase(context.Background(), branch))
		// Setup invalid port
		utils.Config.Db.Port = 65536
		// Run test
		assert.Error(t, ActivateDatabase(context.Background(), branch))
	})

	t.Run("throws error on failure to disconnect", func(t *testing.T) {
		utils.Config.Db.Port = 54322
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("ALTER DATABASE postgres ALLOW_CONNECTIONS false;").
			ReplyError(pgerrcode.InvalidParameterValue, `cannot disallow connections for current database`)
		// Run test
		assert.Error(t, ActivateDatabase(context.Background(), branch, conn.Intercept))
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
		assert.Error(t, ActivateDatabase(context.Background(), branch, conn.Intercept))
	})

	t.Run("throws error on failure to swap", func(t *testing.T) {
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
			Query("ALTER DATABASE "+branch+" RENAME TO postgres;").
			ReplyError(pgerrcode.DuplicateDatabase, `database "postgres" already exists`)
		// Run test
		assert.Error(t, ActivateDatabase(context.Background(), branch, conn.Intercept))
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
					Health: &types.Health{
						Status: "healthy",
					},
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
