package pull

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
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

func TestPullCommand(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), nil, pgconn.Config{}, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on sync failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.InvalidCatalogName, `database "postgres" does not exist`)
		// Run test
		err := Run(context.Background(), nil, dbConfig, "", fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" does not exist (SQLSTATE 3D000)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPullSchema(t *testing.T) {
	t.Run("dumps remote schema", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", "test"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := utils.RunProgram(context.Background(), func(p utils.Program, ctx context.Context) error {
			return run(p, ctx, nil, "0_test.sql", conn.MockClient(t), fsys)
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		contents, err := afero.ReadFile(fsys, "0_test.sql")
		assert.NoError(t, err)
		assert.Equal(t, []byte("test"), contents)
	})

	t.Run("throws error on load user schema failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"}).
			Query(migration.ListSchemas, migration.ManagedSchemas).
			ReplyError(pgerrcode.DuplicateTable, `relation "test" already exists`)
		// Run test
		err := utils.RunProgram(context.Background(), func(p utils.Program, ctx context.Context) error {
			return run(p, ctx, nil, "", conn.MockClient(t), fsys)
		})
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "test" already exists (SQLSTATE 42P07)`)
	})

	t.Run("throws error on diff failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errors.New("network error"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"})
		// Run test
		err := utils.RunProgram(context.Background(), func(p utils.Program, ctx context.Context) error {
			return run(p, ctx, []string{"public"}, "", conn.MockClient(t), fsys)
		})
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestSyncRemote(t *testing.T) {
	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := assertRemoteInSync(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on mismatched length", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := assertRemoteInSync(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, errConflict)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on mismatched migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"20220727064247"})
		// Run test
		err := assertRemoteInSync(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, errConflict)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := assertRemoteInSync(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, errMissing)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
