package push

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
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
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 0")
		// Run test
		err := Run(context.Background(), true, false, false, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores up to date", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
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
		conn.Query(list.LIST_MIGRATION_VERSION).
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

	t.Run("throws error on schema create failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 0").
			Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Query(repair.ADD_NAME_COLUMN)
		// Run test
		err := Run(context.Background(), false, false, false, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)`)
	})

	t.Run("throws error on push failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 0").
			Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.INSERT_MIGRATION_VERSION, "0", "test", "{}").
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Run test
		err := Run(context.Background(), false, false, false, false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement 0: "+repair.INSERT_MIGRATION_VERSION)
	})
}
