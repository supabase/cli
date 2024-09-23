package apply

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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

func TestMigrateDatabase(t *testing.T) {
	t.Run("applies local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema public"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{sql}).
			Reply("INSERT 0 1")
		// Run test
		err := MigrateAndSeed(context.Background(), "", conn.MockClient(t), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("skip seeding when seed config is disabled", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema public"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		seedPath := filepath.Join(utils.DefaultSeedDataPath)
		// This will raise an error when seeding
		require.NoError(t, afero.WriteFile(fsys, seedPath, []byte("INSERT INTO test_table;"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(sql).
			Reply("CREATE SCHEMA").
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{sql}).
			Reply("INSERT 0 1")
		utils.Config.Db.Seed.Enabled = false
		// Run test
		err := MigrateAndSeed(context.Background(), "", conn.MockClient(t), fsys)
		// No error should be returned since seeding is skipped
		assert.NoError(t, err)
	})

	t.Run("ignores empty local directory", func(t *testing.T) {
		assert.NoError(t, MigrateAndSeed(context.Background(), "", nil, afero.NewMemMapFs()))
	})

	t.Run("throws error on open failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Run test
		err := MigrateAndSeed(context.Background(), "", nil, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}

func TestSeedDatabase(t *testing.T) {
	t.Run("seeds from file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.DefaultSeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			Reply("INSERT 0 1")
		// Run test
		err := SeedDatabase(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores missing seed", func(t *testing.T) {
		assert.NoError(t, SeedDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		// Wrap the fs with OpenErrorFs
		errorFs := &fstest.OpenErrorFs{
			DenyPath: utils.DefaultSeedDataPath,
		}
		errorFs.Create(utils.DefaultSeedDataPath)

		// Run test
		err := SeedDatabase(context.Background(), nil, errorFs)

		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup seed file
		sql := "INSERT INTO employees(name) VALUES ('Alice')"
		require.NoError(t, afero.WriteFile(fsys, utils.DefaultSeedDataPath, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			ReplyError(pgerrcode.NotNullViolation, `null value in column "age" of relation "employees"`)
		// Run test
		err := SeedDatabase(context.Background(), conn.MockClient(t), fsys)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "age" of relation "employees" (SQLSTATE 23502)`)
	})
}
