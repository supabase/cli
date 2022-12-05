package push

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

const (
	user     = "admin"
	pass     = "password"
	database = "postgres"
	host     = "localhost"
)

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
		err := Run(context.Background(), true, false, user, pass, database, host, fsys, conn.Intercept)
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
		err := Run(context.Background(), false, false, user, pass, database, host, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), false, false, user, pass, database, "0", fsys)
		// Check error
		assert.ErrorContains(t, err, "dial error (dial tcp 0.0.0.0:6543: connect: connection refused)")
	})

	t.Run("throws error on local load failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		err := Run(context.Background(), false, true, user, pass, database, host, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on remote load failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(list.LIST_MIGRATION_VERSION).
			ReplyError(pgerrcode.UndefinedTable, `relation "supabase_migrations.schema_migrations" does not exist`)
		// Run test
		err := Run(context.Background(), false, false, user, pass, database, host, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "supabase_migrations.schema_migrations" does not exist (SQLSTATE 42P01)`)
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
			Query(commit.INSERT_MIGRATION_VERSION, "0").
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Run test
		err := Run(context.Background(), false, false, user, pass, database, host, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement 0: "+commit.INSERT_MIGRATION_VERSION)
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
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
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
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
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
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
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
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
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
			Query(commit.INSERT_MIGRATION_VERSION, "0").
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
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
		conn.Query(commit.INSERT_MIGRATION_VERSION, "0").
			ReplyError(pgerrcode.NotNullViolation, `null value in column "version" of relation "schema_migrations"`)
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = pushMigration(ctx, mock, "0_test.sql", fsys)
		// Check error
		assert.ErrorContains(t, err, `ERROR: null value in column "version" of relation "schema_migrations" (SQLSTATE 23502)`)
		assert.ErrorContains(t, err, "At statement 0: "+commit.INSERT_MIGRATION_VERSION)
	})
}

func TestPushVersion(t *testing.T) {
	t.Run("push version only", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_zero.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		path = filepath.Join(utils.MigrationsDir, "1_one.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("CREATE SCHEMA IF NOT EXISTS supabase_migrations").
			Reply("CREATE SCHEMA").
			Query("CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)").
			Reply("CREATE TABLE").
			Query(CLEAR_MIGRATION).
			Reply("TRUNCATE TABLE").
			Query(commit.INSERT_MIGRATION_VERSION, "0").
			Reply("INSERT 0 1").
			Query(commit.INSERT_MIGRATION_VERSION, "1").
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectRemotePostgres(ctx, user, pass, database, host, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = pushVersion(context.Background(), false, mock, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("dry run", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_zero.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Run test
		err := pushVersion(context.Background(), true, nil, fsys)
		// Check error
		assert.NoError(t, err)
	})
}
