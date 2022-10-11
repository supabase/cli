package diff

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
)

func TestApplyMigrations(t *testing.T) {
	const postgresUrl = "postgresql://postgres:password@localhost:5432/postgres"

	t.Run("applies migrations from local directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		migrations := map[string]string{
			filepath.Join(utils.MigrationsDir, "20220727064247_init.sql"): "create table test",
			filepath.Join(utils.MigrationsDir, "20220727064248_drop.sql"): "drop table test;\n-- ignore me",
		}
		for path, query := range migrations {
			require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("create table test").
			Reply("SELECT 0").
			Query("drop table test").
			Reply("SELECT 0").
			Query("-- ignore me").
			Reply("")
		// Run test
		assert.NoError(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})

	t.Run("ignores empty local directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		assert.NoError(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})

	t.Run("ignores outdated migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20211208000000_init.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		assert.NoError(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})

	t.Run("throws error on invalid postgres url", func(t *testing.T) {
		assert.Error(t, ApplyMigrations(context.Background(), "invalid", afero.NewMemMapFs()))
	})

	t.Run("throws error on failture to connect", func(t *testing.T) {
		assert.Error(t, ApplyMigrations(context.Background(), postgresUrl, afero.NewMemMapFs()))
	})

	t.Run("throws error on failture to send batch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20220727064247_create_table.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(query).
			ReplyError(pgerrcode.DuplicateTable, `relation "test" already exists`)
		// Run test
		assert.Error(t, ApplyMigrations(context.Background(), postgresUrl, fsys, conn.Intercept))
	})
}
