package up

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

func TestPendingMigrations(t *testing.T) {
	t.Run("finds pending migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			"20221201000000_test.sql",
			"20221201000001_test.sql",
			"20221201000002_test.sql",
			"20221201000003_test.sql",
		}
		for _, name := range files {
			path := filepath.Join(utils.MigrationsDir, name)
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000001"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		pending, err := GetPendingMigrations(ctx, false, mock, fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, files[2:], pending)
	})

	t.Run("throws error on local load failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = GetPendingMigrations(ctx, false, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on missing local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = GetPendingMigrations(ctx, false, mock, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingLocal)
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
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"1"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = GetPendingMigrations(ctx, false, mock, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingRemote)
	})
}

func TestIgnoreVersionMismatch(t *testing.T) {
	t.Run("applies out-of-order local migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		files := []string{
			"20221201000000_test.sql",
			"20221201000001_test.sql",
			"20221201000002_test.sql",
			"20221201000003_test.sql",
		}
		for _, name := range files {
			path := filepath.Join(utils.MigrationsDir, name)
			require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000002"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		pending, err := GetPendingMigrations(ctx, true, mock, fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{files[1], files[3]}, pending)
	})

	t.Run("throws error on missing local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "20221201000000_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"20221201000001"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = GetPendingMigrations(ctx, true, mock, fsys)
		// Check error
		assert.ErrorIs(t, err, errMissingLocal)
	})
}
