package down

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

func TestMigrationsDown(t *testing.T) {
	t.Run("resets last n migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			filepath.Join(utils.MigrationsDir, "20221201000000_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000001_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000002_test.sql"),
		}
		for _, path := range files {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000001"})
		// Run test
		err := Run(context.Background(), 1, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on out of range", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000001"})
		// Run test
		err := Run(context.Background(), 2, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "--last must be smaller than total applied migrations: 2")
	})

	t.Run("throws error on insufficient privilege", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := Run(context.Background(), 1, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}

var escapedSchemas = append(migration.ManagedSchemas, "extensions", "public")

func TestResetRemote(t *testing.T) {
	t.Run("resets remote database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_schema.sql")
		require.NoError(t, afero.WriteFile(fsys, path, nil, 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.ListSchemas, escapedSchemas).
			Reply("SELECT 1", []interface{}{"private"}).
			Query("DROP SCHEMA IF EXISTS private CASCADE").
			Reply("DROP SCHEMA").
			Query(migration.DropObjects).
			Reply("INSERT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "schema", nil).
			Reply("INSERT 0 1")
		// Run test
		err := ResetAll(context.Background(), "", conn.MockClient(t), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("resets remote database with seed config disabled", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_schema.sql")
		require.NoError(t, afero.WriteFile(fsys, path, nil, 0644))
		seedPath := filepath.Join(utils.SupabaseDirPath, "seed.sql")
		// Will raise an error when seeding
		require.NoError(t, afero.WriteFile(fsys, seedPath, []byte("INSERT INTO test_table;"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.ListSchemas, escapedSchemas).
			Reply("SELECT 1", []interface{}{"private"}).
			Query("DROP SCHEMA IF EXISTS private CASCADE").
			Reply("DROP SCHEMA").
			Query(migration.DropObjects).
			Reply("INSERT 0")
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "schema", nil).
			Reply("INSERT 0 1")
		utils.Config.Db.Seed.Enabled = false
		// Run test
		err := ResetAll(context.Background(), "", conn.MockClient(t), fsys)
		// No error should be raised since we're skipping the seed
		assert.NoError(t, err)
	})

	t.Run("throws error on drop schema failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.ListSchemas, escapedSchemas).
			Reply("SELECT 0").
			Query(migration.DropObjects).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := ResetAll(context.Background(), "", conn.MockClient(t), fsys)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}
