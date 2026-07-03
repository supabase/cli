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
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	pkgconfig "github.com/supabase/cli/pkg/config"
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

func TestLoadDeclaredSchemas(t *testing.T) {
	t.Run("respects schema_paths order when pg-delta declarative dir exists", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.Migrations.SchemaPaths = pkgconfig.Glob{
			"supabase/schemas/z_function.sql",
			"supabase/schemas/a_table.sql",
		}
		utils.Config.Experimental.PgDelta = &pkgconfig.PgDeltaConfig{
			Enabled:               true,
			DeclarativeSchemaPath: utils.SchemasDir,
		}
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.MkdirAll(utils.SchemasDir, 0755))
		require.NoError(t, afero.WriteFile(fsys, "supabase/schemas/a_table.sql", []byte("create table a();"), 0644))
		require.NoError(t, afero.WriteFile(fsys, "supabase/schemas/z_function.sql", []byte("create function z() returns void language sql as $$ select 1 $$;"), 0644))

		declared, err := loadDeclaredSchemas(fsys)

		require.NoError(t, err)
		assert.Equal(t, []string{
			"supabase/schemas/z_function.sql",
			"supabase/schemas/a_table.sql",
		}, declared)
	})

	t.Run("expands schema_paths directory entries deterministically", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.Migrations.SchemaPaths = pkgconfig.Glob{utils.DeclarativeDir}
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.MkdirAll(filepath.Join(utils.DeclarativeDir, "nested"), 0755))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.DeclarativeDir, "nested", "b.sql"), []byte("select 2;"), 0644))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.DeclarativeDir, "a.sql"), []byte("select 1;"), 0644))

		declared, err := loadDeclaredSchemas(fsys)

		require.NoError(t, err)
		assert.Equal(t, []string{
			filepath.Join(utils.DeclarativeDir, "a.sql"),
			filepath.Join(utils.DeclarativeDir, "nested", "b.sql"),
		}, declared)
	})
}

func TestShouldApplyDeclarativeWithPgDelta(t *testing.T) {
	t.Run("uses pg-delta declarative apply when no schema_paths override is configured", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.Migrations.SchemaPaths = nil

		assert.True(t, shouldApplyDeclarativeWithPgDelta(true))
	})

	t.Run("uses pg-delta declarative apply when schema_paths points at the declarative dir", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.Migrations.SchemaPaths = pkgconfig.Glob{utils.DeclarativeDir + "/"}

		assert.True(t, shouldApplyDeclarativeWithPgDelta(true))
	})

	t.Run("uses ordered migration apply for explicit schema_paths files", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.Migrations.SchemaPaths = pkgconfig.Glob{
			"supabase/schemas/z_function.sql",
			"supabase/schemas/a_table.sql",
		}

		assert.False(t, shouldApplyDeclarativeWithPgDelta(true))
	})
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), "test-migra")
		diff := "create table test();"
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-migra", diff))
		// Setup mock postgres: with auto_expose_new_tables unset, the shadow database setup
		// revokes the default Data API GRANTs before creating the regression template.
		conn := pgtest.NewConn()
		helper.MockApiPrivilegesRevoke(conn).
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		defer conn.Close(t)
		// Run test
		err := Run(context.Background(), []string{"public"}, "file", dbConfig, DiffSchemaMigra, false, fsys, func(cc *pgx.ConnConfig) {
			if cc.Host == dbConfig.Host {
				// Fake a SSL error when connecting to target database
				cc.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
					return nil, errors.New("server refused TLS connection")
				}
			} else {
				// Hijack connection to shadow database
				conn.Intercept(cc)
			}
		})
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

	t.Run("applies schema_paths in order before saving generated diff", func(t *testing.T) {
		originalConfig := utils.Config
		t.Cleanup(func() { utils.Config = originalConfig })
		utils.Config.Db.MajorVersion = 14
		utils.Config.Db.ShadowPort = 54320
		utils.Config.Db.Migrations.SchemaPaths = pkgconfig.Glob{
			"supabase/schemas/z_function.sql",
			"supabase/schemas/a_table.sql",
		}
		utils.Config.Experimental.PgDelta = &pkgconfig.PgDeltaConfig{
			Enabled:               true,
			DeclarativeSchemaPath: utils.SchemasDir,
		}
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		functionSQL := "create function public.z_function() returns integer language sql as $$ select 1 $$"
		tableSQL := "create table public.a_table (id integer default public.z_function())"
		generated := functionSQL + ";\n" + tableSQL + ";\n"
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, "supabase/schemas/a_table.sql", []byte(tableSQL), 0644))
		require.NoError(t, afero.WriteFile(fsys, "supabase/schemas/z_function.sql", []byte(functionSQL), 0644))
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
		shadowConn := pgtest.NewConn()
		defer shadowConn.Close(t)
		shadowConn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(shadowConn).
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		declaredConn := pgtest.NewConn()
		defer declaredConn.Close(t)
		declaredConn.Query(functionSQL).
			Reply("CREATE FUNCTION").
			Query(tableSQL).
			Reply("CREATE TABLE")
		diffCalled := false
		differ := func(_ context.Context, _, target pgconn.Config, schema []string, _ ...func(*pgx.ConnConfig)) (string, error) {
			diffCalled = true
			assert.Equal(t, "contrib_regression", target.Database)
			assert.Equal(t, []string{"public"}, schema)
			return generated, nil
		}
		localConfig := pgconn.Config{
			Host:     utils.Config.Hostname,
			Port:     utils.Config.Db.Port,
			User:     "postgres",
			Password: utils.Config.Db.Password,
			Database: "postgres",
		}

		err := Run(context.Background(), []string{"public"}, "ordered_schema", localConfig, differ, true, fsys, func(cc *pgx.ConnConfig) {
			if cc.Database == "contrib_regression" {
				declaredConn.Intercept(cc)
			} else {
				shadowConn.Intercept(cc)
			}
		})

		require.NoError(t, err)
		assert.True(t, diffCalled)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		require.NoError(t, err)
		require.Len(t, files, 1)
		contents, err := afero.ReadFile(fsys, filepath.Join(utils.MigrationsDir, files[0].Name()))
		require.NoError(t, err)
		assert.Equal(t, []byte(generated), contents)
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
		err := Run(context.Background(), []string{"public"}, "file", dbConfig, DiffSchemaMigra, false, fsys)
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
			Reply("CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(conn).
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		helper.MockMigrationHistory(conn).
			Query("RESET ALL").
			Reply("RESET").
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

func TestSetupShadowDatabase(t *testing.T) {
	utils.Config.Db.MajorVersion = 14

	t.Run("sets up platform baseline without applying migrations", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaPg14Sql = "create schema private"
		// A migration exists on disk, but SetupShadowDatabase must not apply it:
		// the mock below only scripts the platform setup + template, so any
		// migration-history query would surface as an unmatched request.
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte("create schema test"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaPg14Sql).
			Reply("CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(conn).
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		// Run test
		err := SetupShadowDatabase(context.Background(), "test-shadow-db", fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on globals schema", func(t *testing.T) {
		utils.Config.Db.ShadowPort = 54320
		utils.GlobalsSql = "create schema public"
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`)
		// Run test
		err := SetupShadowDatabase(context.Background(), "test-shadow-db", afero.NewMemMapFs(), conn.Intercept)
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
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errNetwork)
		// Run test
		result, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, false)
		// Check error
		assert.Empty(t, result)
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on health check failure", func(t *testing.T) {
		utils.Config.Db.HealthTimeout = time.Millisecond
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
		result, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, false)
		// Check error
		assert.Empty(t, result)
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
		result, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, false, conn.Intercept)
		// Check error
		assert.Empty(t, result)
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
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), "test-migra")
		// The edge-runtime diff waits for the container to exit via inspect before
		// reading its logs (it must not follow the log stream — that hangs under
		// podman, supabase/pg-toolbelt#312), so the diff failure here surfaces from
		// the log read rather than the followed stream.
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-migra/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{ExitCode: 0},
			}})
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
			Reply("CREATE SCHEMA")
		helper.MockApiPrivilegesRevoke(conn).
			Query(CREATE_TEMPLATE).
			Reply("CREATE DATABASE")
		helper.MockMigrationHistory(conn).
			Query("RESET ALL").
			Reply("RESET").
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{sql}).
			Reply("INSERT 0 1")
		// Run test
		result, err := DiffDatabase(context.Background(), []string{"public"}, dbConfig, io.Discard, fsys, DiffSchemaMigra, false, func(cc *pgx.ConnConfig) {
			if cc.Host == dbConfig.Host {
				// Fake a SSL error when connecting to target database
				cc.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
					return nil, errors.New("server refused TLS connection")
				}
			} else {
				// Hijack connection to shadow database
				conn.Intercept(cc)
			}
		})
		// Check error
		assert.Empty(t, result)
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

func TestLoadSchemasSkipsEmptySchemaPathGlobs(t *testing.T) {
	fsys := afero.NewMemMapFs()
	matched := filepath.Join(utils.SupabaseDirPath, "schemas", "tables", "players.sql")
	require.NoError(t, afero.WriteFile(fsys, matched, nil, 0644))
	utils.Config.Db.Migrations.SchemaPaths = []string{
		filepath.Join(utils.SupabaseDirPath, "schemas", "tables", "*.sql"),
		filepath.Join(utils.SupabaseDirPath, "schemas", "materialized_views", "*.sql"),
	}
	t.Cleanup(func() {
		utils.Config.Db.Migrations.SchemaPaths = nil
	})

	schemas, err := loadDeclaredSchemas(fsys)

	assert.NoError(t, err)
	assert.Equal(t, []string{filepath.ToSlash(matched)}, schemas)
}

func TestLoadSchemasErrorsOnMissingLiteralSchemaPath(t *testing.T) {
	fsys := afero.NewMemMapFs()
	utils.Config.Db.Migrations.SchemaPaths = []string{
		filepath.Join(utils.SupabaseDirPath, "schemas", "tables", "players.sql"),
	}
	t.Cleanup(func() {
		utils.Config.Db.Migrations.SchemaPaths = nil
	})

	schemas, err := loadDeclaredSchemas(fsys)

	assert.ErrorContains(t, err, "no files matched pattern")
	assert.Empty(t, schemas)
}

func TestLoadSchemasErrorsWhenAllSchemaPathGlobsAreEmpty(t *testing.T) {
	fsys := afero.NewMemMapFs()
	utils.Config.Db.Migrations.SchemaPaths = []string{
		filepath.Join(utils.SupabaseDirPath, "schemas", "tables", "*.sql"),
		filepath.Join(utils.SupabaseDirPath, "schemas", "views", "*.sql"),
	}
	t.Cleanup(func() {
		utils.Config.Db.Migrations.SchemaPaths = nil
	})

	schemas, err := loadDeclaredSchemas(fsys)

	assert.ErrorContains(t, err, "no files matched pattern")
	assert.Empty(t, schemas)
}
