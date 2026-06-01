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
	"github.com/supabase/cli/internal/db/diff"
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
		err := Run(context.Background(), nil, pgconn.Config{}, "", false, false, diff.DiffSchemaMigra, fsys)
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
		err := Run(context.Background(), nil, dbConfig, "", false, false, diff.DiffSchemaMigra, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "postgres" does not exist (SQLSTATE 3D000)`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPullSchema(t *testing.T) {
	t.Run("dumps remote schema", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Db.Image), "test-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-db", "test"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errNetwork)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := run(context.Background(), nil, "0_test.sql", conn.MockClient(t), false, diff.DiffSchemaMigra, fsys)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		contents, err := afero.ReadFile(fsys, "0_test.sql")
		assert.NoError(t, err)
		assert.Equal(t, []byte("test"), contents)
	})

	t.Run("skips pg_dump for pg-delta diff engine on initial pull", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker. Only mock the image inspect call that
		// CreateShadowDatabase makes; do NOT mock the pg_dump container so
		// the test fails loudly if pg_dump is still invoked.
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + utils.GetRegistryImageUrl(utils.Config.Db.Image) + "/json").
			ReplyError(errNetwork)
		// Setup mock postgres (no local migrations -> initial pull path)
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test with usePgDeltaDiff=true
		err := run(context.Background(), nil, "0_test.sql", conn.MockClient(t), true, diff.DiffPgDelta, fsys)
		// Failure must come from shadow-creation image inspect (proving we
		// reached the diff step), not from pg_dump.
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		exists, err := afero.Exists(fsys, "0_test.sql")
		assert.NoError(t, err)
		assert.False(t, exists, "pg_dump should be skipped for pg-delta diff engine")
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
			Reply("SELECT 1", []any{"0"})
		// Run test
		err := run(context.Background(), []string{"public"}, "", conn.MockClient(t), false, diff.DiffSchemaMigra, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestInitialPullInSync(t *testing.T) {
	fsys := afero.NewMemMapFs()
	path := "0_test.sql"

	t.Run("swallows errInSync when pg_dump already wrote migration content", func(t *testing.T) {
		require.NoError(t, afero.WriteFile(fsys, path, []byte("create table t(id int);"), 0644))
		err := swallowInitialInSync(errInSync, fsys, path)
		assert.NoError(t, err)
	})

	t.Run("returns errInSync for pg-delta initial pull with no migration file", func(t *testing.T) {
		err := swallowInitialInSync(errInSync, fsys, "missing.sql")
		assert.ErrorIs(t, err, errInSync)
	})

	t.Run("returns errInSync when migration file is empty", func(t *testing.T) {
		require.NoError(t, afero.WriteFile(fsys, "empty.sql", []byte{}, 0644))
		err := swallowInitialInSync(errInSync, fsys, "empty.sql")
		assert.ErrorIs(t, err, errInSync)
	})
}

func TestEnsureMigrationWritten(t *testing.T) {
	fsys := afero.NewMemMapFs()

	t.Run("passes when migration file has content", func(t *testing.T) {
		path := "0_test.sql"
		require.NoError(t, afero.WriteFile(fsys, path, []byte("create table t(id int);"), 0644))
		assert.NoError(t, ensureMigrationWritten(fsys, path))
	})

	t.Run("returns errInSync when migration file is missing", func(t *testing.T) {
		err := ensureMigrationWritten(fsys, "missing.sql")
		assert.ErrorIs(t, err, errInSync)
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
			Reply("SELECT 1", []any{"20220727064247"})
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
