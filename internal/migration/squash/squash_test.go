package squash

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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

func TestSquashCommand(t *testing.T) {
	t.Run("squashes local migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, flags.LoadConfig(fsys))
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "init", []string{sql}).
			Reply("INSERT 0 1").
			Query(migration.INSERT_MIGRATION_VERSION, "1", "target", nil).
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), "", pgconn.Config{
			Host: "127.0.0.1",
			Port: 54322,
		}, fsys, conn.Intercept)
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
		path := filepath.Join(utils.MigrationsDir, "0_init.sql")
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(fmt.Sprintf("DELETE FROM supabase_migrations.schema_migrations WHERE version <=  '0' ;INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES( '0' ,  'init' ,  '{%s}' )", sql)).
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), "0", dbConfig, fsys, conn.Intercept, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		})
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

	t.Run("throws error on missing migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "0", pgconn.Config{}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}

func TestSquashVersion(t *testing.T) {
	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Run test
		err := squashToVersion(context.Background(), "0", fsys)
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
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := squashToVersion(context.Background(), "1", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSquashMigrations(t *testing.T) {
	utils.Config.Db.MajorVersion = 15
	utils.Config.Db.ShadowPort = 54320

	t.Run("throws error on shadow create failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := squashMigrations(context.Background(), nil, fsys)
		// Check error
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
		err := squashMigrations(context.Background(), nil, fsys)
		// Check error
		assert.ErrorContains(t, err, "test-shadow-db container is not running: exited")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on shadow migrate failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, flags.LoadConfig(fsys))
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
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Realtime.Image) + "/json").
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", sql))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "init", []string{sql}).
			Reply("INSERT 0 1")
		// Run test
		err := squashMigrations(context.Background(), []string{path}, afero.NewReadOnlyFs(fsys), conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestBaselineMigration(t *testing.T) {
	t.Run("baselines earliest version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		paths := []string{
			filepath.Join(utils.MigrationsDir, "0_init.sql"),
			filepath.Join(utils.MigrationsDir, "1_target.sql"),
		}
		sql := "create schema test"
		require.NoError(t, afero.WriteFile(fsys, paths[0], []byte(sql), 0644))
		require.NoError(t, afero.WriteFile(fsys, paths[1], []byte{}, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(fmt.Sprintf("DELETE FROM supabase_migrations.schema_migrations WHERE version <=  '0' ;INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES( '0' ,  'init' ,  '{%s}' )", sql)).
			Reply("INSERT 0 1")
		// Run test
		err := baselineMigrations(context.Background(), dbConfig, "", fsys, conn.Intercept, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		})
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := baselineMigrations(context.Background(), pgconn.Config{}, "0", fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on query failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_init.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(fmt.Sprintf("DELETE FROM supabase_migrations.schema_migrations WHERE version <=  '%[1]s' ;INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES( '%[1]s' ,  'init' ,  null )", "0")).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := baselineMigrations(context.Background(), dbConfig, "0", fsys, conn.Intercept, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		})
		// Check error
		assert.ErrorContains(t, err, `ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)`)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn)
		// Run test
		err := baselineMigrations(context.Background(), dbConfig, "0", fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}

//go:embed testdata/*.sql
var testdata embed.FS

func TestLineByLine(t *testing.T) {
	t.Run("diffs output from pg_dump", func(t *testing.T) {
		before, err := testdata.Open("testdata/before.sql")
		require.NoError(t, err)
		after, err := testdata.Open("testdata/after.sql")
		require.NoError(t, err)
		expected, err := testdata.ReadFile("testdata/diff.sql")
		require.NoError(t, err)
		// Run test
		var out bytes.Buffer
		err = lineByLineDiff(before, after, &out)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, expected, out.Bytes())
	})

	t.Run("diffs shorter before", func(t *testing.T) {
		before := strings.NewReader("select 1;")
		after := strings.NewReader("select 0;\nselect 1;\nselect 2;")
		// Run test
		var out bytes.Buffer
		err := lineByLineDiff(before, after, &out)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "select 0;\nselect 2;\n", out.String())
	})

	t.Run("diffs shorter after", func(t *testing.T) {
		before := strings.NewReader("select 1;\nselect 2;")
		after := strings.NewReader("select 1;")
		// Run test
		var out bytes.Buffer
		err := lineByLineDiff(before, after, &out)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "", out.String())
	})

	t.Run("diffs no match", func(t *testing.T) {
		before := strings.NewReader("select 0;\nselect 1;")
		after := strings.NewReader("select 1;")
		// Run test
		var out bytes.Buffer
		err := lineByLineDiff(before, after, &out)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "select 1;\n", out.String())
	})
}
