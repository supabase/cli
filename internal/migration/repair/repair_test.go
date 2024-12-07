package repair

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
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
	Host:     "db.supabase.com",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRepairCommand(t *testing.T) {
	t.Run("applies new version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte("select 1"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", []string{"select 1"}).
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), dbConfig, []string{"0"}, Applied, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("reverts old version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(migration.DELETE_MIGRATION_VERSION, []string{"0"}).
			Reply("DELETE 1")
		// Run test
		err := Run(context.Background(), dbConfig, []string{"0"}, Reverted, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), pgconn.Config{}, []string{"invalid"}, Applied, fsys)
		// Check error
		assert.ErrorIs(t, err, ErrInvalidVersion)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), pgconn.Config{}, []string{"0"}, Applied, fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(migration.INSERT_MIGRATION_VERSION, "0", "test", nil).
			ReplyError(pgerrcode.DuplicateObject, `relation "supabase_migrations.schema_migrations" does not exist`)
		// Run test
		err := Run(context.Background(), dbConfig, []string{"0"}, Applied, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "supabase_migrations.schema_migrations" does not exist (SQLSTATE 42710)`)
	})
}

func TestRepairAll(t *testing.T) {
	t.Run("repairs whole history", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte("select 1"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(migration.TRUNCATE_VERSION_TABLE + `;INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES( '0' ,  'test' ,  '{select 1}' )`).
			Reply("TRUNCATE TABLE").
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), dbConfig, nil, Applied, fsys, conn.Intercept, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		})
		// Check error
		assert.NoError(t, err)
	})

	t.Run("reverts whole history", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		helper.MockMigrationHistory(conn).
			Query(migration.TRUNCATE_VERSION_TABLE).
			Reply("TRUNCATE TABLE")
		// Run test
		err := Run(context.Background(), dbConfig, nil, Reverted, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on cancel", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), dbConfig, nil, Applied, fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Run test
		err := Run(context.Background(), dbConfig, nil, Applied, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}
