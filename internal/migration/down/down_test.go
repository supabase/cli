package down

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.LIST_MIGRATION_VERSION).
			Reply("SELECT 2", []interface{}{"20221201000000"}, []interface{}{"20221201000001"})
		// Run test
		err := Run(context.Background(), 1, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
