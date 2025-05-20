package push

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestMigrationPush(t *testing.T) {
	t.Run("dry run", func(t *testing.T) {
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
		err := Run(context.Background(), true, false, true, true, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores up to date", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), false, false, false, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), false, false, false, false, pgconn.Config{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on remote load failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.InvalidCatalogName, `database "target" does not exist`)
		// Run test
		err := Run(context.Background(), false, false, false, false, pgconn.Config{
			Host:     "db.supabase.co",
			Port:     5432,
			User:     "admin",
			Password: "password",
			Database: "postgres",
		}, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: database "target" does not exist (SQLSTATE 3D000)`)
	})

	t.Run("throws error on push failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", nil).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Run test
		err := Run(context.Background(), false, false, false, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement: 0\n"+migration.INSERT_MIGRATION_VERSION)
	})
}

func TestPushAll(t *testing.T) {
	t.Run("ignores missing roles and seed", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", nil).
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), false, false, true, true, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on cancel", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "n"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), false, false, true, true, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on roles failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.StatErrorFs{DenyPath: utils.CustomRolesPath}
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), false, false, true, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on seed failure", func(t *testing.T) {
		digest := hex.EncodeToString(sha256.New().Sum(nil))
		seedPath := filepath.Join(utils.SupabaseDirPath, "seed.sql")
		utils.Config.Db.Seed.SqlPaths = []string{seedPath}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, seedPath, []byte{}, 0644))
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0").
			Query(migration.SELECT_SEED_TABLE).
			Reply("SELECT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", nil).
			Reply("INSERT 0 1")
		helper.MockSeedHistory(conn).
			Query(migration.UPSERT_SEED_FILE, seedPath, digest).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "hash" of relation "seed_files"`)
		// Run test
		err := Run(context.Background(), false, false, false, true, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "hash" of relation "seed_files" (SQLSTATE 23502)`)
	})
}
