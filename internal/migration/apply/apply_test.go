package apply

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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
		seedPath := filepath.Join(utils.SupabaseDirPath, "seed.sql")
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
