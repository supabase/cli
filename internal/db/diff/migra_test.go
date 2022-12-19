package diff

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
	"gopkg.in/h2non/gock.v1"
)

func TestRunMigra(t *testing.T) {
	t.Run("runs migra diff", func(t *testing.T) {
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg15Sql = "create schema private"
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
			Post("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/stop").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.MigraImage), "test-migra")
		diff := "create table test();"
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-migra", diff))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg15Sql).
			Reply("CREATE SCHEMA")
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "file", "password", fsys, conn.Intercept)
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
		err := RunMigra(context.Background(), []string{"public"}, "", "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Missing config: open supabase/config.toml: file does not exist")
	})

	t.Run("throws error on missing project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "", "password", fsys)
		// Check error
		assert.ErrorContains(t, err, "Cannot find project ref. Have you run supabase link?")
	})

	t.Run("throws error on missing database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_").
			ReplyError(errors.New("network error"))
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "", "", fsys)
		// Check error
		assert.ErrorContains(t, err, "supabase start is not running.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to create shadow", func(t *testing.T) {
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
		err := RunMigra(context.Background(), []string{"public"}, "", "password", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to migrate shadow", func(t *testing.T) {
		utils.GlobalsSql = "create schema public"
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
			Post("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/stop").
			Reply(http.StatusOK)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "", "password", fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)
At statement 0: create schema public`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to diff target", func(t *testing.T) {
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg15Sql = "create schema private"
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
			Post("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/stop").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.MigraImage), "test-migra")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-migra/logs").
			ReplyError(errors.New("network error"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg15Sql).
			Reply("CREATE SCHEMA")
		// Run test
		err := RunMigra(context.Background(), []string{"public"}, "file", "password", fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "error diffing schema")
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check diff file
		exists, err := afero.DirExists(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.True(t, exists)
	})
}

func TestBuildTarget(t *testing.T) {
	t.Run("builds remote url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Run test
		url, err := buildTargetUrl("password", fsys)
		// Check output
		assert.NoError(t, err)
		assert.Equal(t, "postgresql://postgres:password@db."+project+".supabase.co:6543/postgres", url)
	})

	t.Run("builds local url", func(t *testing.T) {
		utils.DbId = "postgres"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		url, err := buildTargetUrl("", fsys)
		// Check output
		assert.NoError(t, err)
		assert.Equal(t, "postgresql://postgres:postgres@postgres:5432/postgres", url)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestApplyMigrations(t *testing.T) {
	const postgresUrl = "postgresql://postgres:password@localhost:5432/postgres"

	t.Run("applies migrations from local directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		migrations := map[string]string{
			filepath.Join(utils.MigrationsDir, "20220727064247_init.sql"): "create table test",
			filepath.Join(utils.MigrationsDir, "20220727064248_drop.sql"): "drop table test;\n-- ignore me",
		}
		for path, query := range migrations {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("create table test").
			Reply("SELECT 0").
			Query("drop table test").
			Reply("SELECT 0").
			Query("-- ignore me").
			Reply("")
		// Run test
		assert.NoError(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})

	t.Run("throws error on invalid postgres url", func(t *testing.T) {
		assert.Error(t, ApplyMigrations(context.Background(), "invalid", afero.NewMemMapFs()))
	})

	t.Run("throws error on failture to connect", func(t *testing.T) {
		assert.Error(t, ApplyMigrations(context.Background(), postgresUrl, afero.NewMemMapFs()))
	})

	t.Run("throws error on failture to send batch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20220727064247_create_table.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(query).
			ReplyError(pgerrcode.DuplicateTable, `relation "test" already exists`)
		// Run test
		assert.Error(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})
}

func TestMigrateDatabase(t *testing.T) {
	t.Run("ignores empty local directory", func(t *testing.T) {
		assert.NoError(t, MigrateDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("ignores outdated migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20211208000000_init.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		err := MigrateDatabase(context.Background(), nil, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on failture to scan token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20220727064247_create_table.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "BEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		err := MigrateDatabase(context.Background(), nil, fsys)
		// Check error
		assert.ErrorContains(t, err, "bufio.Scanner: token too long\nAfter statement 1: BEGIN;")
	})
}

func TestMigrateShadow(t *testing.T) {
	t.Run("throws error on timeout", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup cancelled context
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		// Run test
		err := migrateShadowDatabase(ctx, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation was canceled")
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
		err := migrateShadowDatabase(ctx, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
	})

	t.Run("throws error on initial schema", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaSql = "create schema private"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := migrateShadowDatabase(ctx, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: schema "public" already exists (SQLSTATE 42P06)`)
	})
}
