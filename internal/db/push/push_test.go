package push

import (
	"bytes"
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
	"github.com/supabase/cli/internal/utils/parser"
)

var dbConfig = pgconn.Config{
	Host:     "localhost",
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
		err := Run(context.Background(), true, dbConfig, fsys, conn.Intercept)
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
		err := Run(context.Background(), false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), false, pgconn.Config{}, fsys)
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
		err := Run(context.Background(), false, dbConfig, fsys, conn.Intercept)
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
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := Run(context.Background(), false, dbConfig, fsys, conn.Intercept)
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
			Query(repair.INSERT_MIGRATION_VERSION, "0").
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Run test
		err := Run(context.Background(), false, dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement 0: "+repair.INSERT_MIGRATION_VERSION)
	})
}

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
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		pending, err := getPendingMigrations(ctx, mock, fsys)
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
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = getPendingMigrations(ctx, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on missing migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = getPendingMigrations(ctx, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, "Found 1 versions and 0 migrations.")
	})

	t.Run("throws error on version mismatch", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "1_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			Reply("SELECT 1", []interface{}{"0"})
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = getPendingMigrations(ctx, mock, fsys)
		// Check error
		assert.ErrorContains(t, err, "Expected version 0 but found migration 1_test.sql at index 0.")
	})
}

func TestPushLocal(t *testing.T) {
	t.Run("pushes local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema public"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			Reply("CREATE SCHEMA").
			Query(repair.INSERT_MIGRATION_VERSION, "0").
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = pushMigration(ctx, mock, "0_test.sql", fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := pushMigration(context.Background(), nil, "0_test.sql", fsys)
		// Check error
		assert.ErrorContains(t, err, "open supabase/migrations/0_test.sql: file does not exist")
	})

	t.Run("throws error on split failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := bytes.Repeat([]byte{'a'}, parser.MaxScannerCapacity)
		require.NoError(t, afero.WriteFile(fsys, path, sql, 0644))
		// Run test
		err := pushMigration(context.Background(), nil, "0_test.sql", fsys)
		// Check error
		assert.ErrorContains(t, err, "bufio.Scanner: token too long\nAfter statement 0: ")
	})

	t.Run("throws error on exec failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.INSERT_MIGRATION_VERSION, "0").
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = pushMigration(ctx, mock, "0_test.sql", fsys)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement 0: "+repair.INSERT_MIGRATION_VERSION)
	})
}
