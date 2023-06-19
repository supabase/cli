package squash

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     "localhost",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestSquashCommand(t *testing.T) {
	t.Run("squashes local migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		paths := []string{
			filepath.Join(utils.MigrationsDir, "0_init.sql"),
			filepath.Join(utils.MigrationsDir, "1_target.sql"),
		}
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, paths[0], []byte(sql), 0644))
		require.NoError(t, afero.WriteFile(fsys, paths[1], []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg15Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StorageImage), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg15Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(repair.INSERT_MIGRATION_VERSION, "0", fmt.Sprintf("{%s}", sql)).
			Reply("INSERT 1").
			Query(repair.INSERT_MIGRATION_VERSION, "1", "{}").
			Reply("INSERT 1")
		// Run test
		err := Run(context.Background(), "1", pgconn.Config{}, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.Exists(fsys, paths[0])
		assert.NoError(t, err)
		assert.False(t, exists)
		match, err := afero.FileContainsBytes(fsys, paths[1], []byte(sql))
		assert.NoError(t, err)
		assert.True(t, match)
	})

	t.Run("baselines migration history", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		path := filepath.Join(utils.MigrationsDir, "0_init.sql")
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(fmt.Sprintf("DELETE FROM supabase_migrations.schema_migrations WHERE version <= '%[1]d';INSERT INTO supabase_migrations.schema_migrations(version, statements) VALUES('%[1]d', '{%[2]s}')", 0, sql)).
			Reply("INSERT 1")
		// Run test
		err := Run(context.Background(), "0", dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		match, err := afero.FileContainsBytes(fsys, path, []byte(sql))
		assert.NoError(t, err)
		assert.True(t, match)
	})

	t.Run("throws error on invalid version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "0_init", pgconn.Config{}, fsys)
		// Check error
		assert.ErrorIs(t, err, repair.ErrInvalidVersion)
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "0", pgconn.Config{}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}

func TestSquashVersion(t *testing.T) {
	utils.DbImage = utils.Pg15Image

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := squashToVersion(context.Background(), "0", afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := squashToVersion(context.Background(), "0", fsys)
		// Check error
		assert.ErrorIs(t, err, ErrMissingVersion)
	})

	t.Run("throws error on shadow create failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_init.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		path = filepath.Join(utils.MigrationsDir, "1_target.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.DbImage) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := squashToVersion(context.Background(), "1", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSquashMigrations(t *testing.T) {
	utils.DbImage = utils.Pg15Image
	utils.Config.Db.MajorVersion = 15
	utils.Config.Db.ShadowPort = 54320

	t.Run("throws error on shadow create failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.DbImage) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := squashMigrations(context.Background(), nil, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on shadow migrate failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DbImage), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.StorageImage) + "/json").
			ReplyError(errors.New("network error"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := squashMigrations(context.Background(), nil, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_init.sql")
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DbImage), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StorageImage), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(repair.INSERT_MIGRATION_VERSION, "0", fmt.Sprintf("{%s}", sql)).
			Reply("INSERT 1")
		// Run test
		err := squashMigrations(context.Background(), []string{filepath.Base(path)}, afero.NewReadOnlyFs(fsys), conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestBaselineMigration(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := baselineMigrations(context.Background(), pgconn.Config{}, "0", fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on create failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(repair.ADD_STATEMENTS_COLUMN)
		// Run test
		err := baselineMigrations(context.Background(), dbConfig, "0", fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)`)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE")
		// Run test
		err := baselineMigrations(context.Background(), dbConfig, "0", fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
