package up

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestPendingMigrations(t *testing.T) {
	t.Run("finds pending migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			filepath.Join(utils.MigrationsDir, "20221201000000_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000001_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000002_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000003_test.sql"),
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
		pending, err := GetPendingMigrations(context.Background(), false, conn.MockClient(t), fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, files[2:], pending)
	})

	t.Run("throws error on local load failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		_, err := GetPendingMigrations(context.Background(), false, conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on missing local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"})
		// Run test
		_, err := GetPendingMigrations(context.Background(), false, conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, migration.ErrMissingLocal)
		assert.Contains(t, utils.CmdSuggestion, "supabase migration repair --status reverted 0")
	})

	t.Run("throws error on missing remote version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{"0_test.sql", "1_test.sql"}
		for _, name := range files {
			path := filepath.Join(utils.MigrationsDir, name)
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"1"})
		// Run test
		_, err := GetPendingMigrations(context.Background(), false, conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, migration.ErrMissingRemote)
	})
}

func TestIgnoreVersionMismatch(t *testing.T) {
	t.Run("applies out-of-order local migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			filepath.Join(utils.MigrationsDir, "20221201000000_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000001_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000002_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000003_test.sql"),
		}
		for _, path := range files {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000002"})
		// Run test
		pending, err := GetPendingMigrations(context.Background(), true, conn.MockClient(t), fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{files[1], files[3]}, pending)
	})

	t.Run("throws error on missing local and remote migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			filepath.Join(utils.MigrationsDir, "20221201000000_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000001_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000002_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000003_test.sql"),
		}
		for _, path := range files {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000002"}, []interface{}{"20221201000004"})
		// Run test
		_, err := GetPendingMigrations(context.Background(), true, conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, migration.ErrMissingLocal)
		assert.Contains(t, utils.CmdSuggestion, "supabase migration repair --status reverted 20221201000004")
	})

	t.Run("throws error on missing local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			filepath.Join(utils.MigrationsDir, "20221201000000_test.sql"),
			filepath.Join(utils.MigrationsDir, "20221201000002_test.sql"),
		}
		for _, path := range files {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 5",
				[]interface{}{"20221201000000"},
				[]interface{}{"20221201000001"},
				[]interface{}{"20221201000002"},
				[]interface{}{"20221201000003"},
				[]interface{}{"20221201000004"},
			)
		// Run test
		_, err := GetPendingMigrations(context.Background(), true, conn.MockClient(t), fsys)
		// Check error
		assert.ErrorIs(t, err, migration.ErrMissingLocal)
		assert.Contains(t, utils.CmdSuggestion, "supabase migration repair --status reverted 20221201000001 20221201000003 20221201000004")
	})
}
