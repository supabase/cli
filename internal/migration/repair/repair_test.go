package repair

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/history"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
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
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.INSERT_MIGRATION_VERSION, "0", "test", []string{"select 1"}).
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
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.DELETE_MIGRATION_VERSION, []string{"0"}).
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
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.INSERT_MIGRATION_VERSION, "0", "test", nil).
			ReplyError(pgerrcode.DuplicateObject, `relation "supabase_migrations.schema_migrations" does not exist`)
		// Run test
		err := Run(context.Background(), dbConfig, []string{"0"}, Applied, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "supabase_migrations.schema_migrations" does not exist (SQLSTATE 42710)`)
	})
}

func TestRepairAll(t *testing.T) {
	t.Run("repairs whole history", func(t *testing.T) {
		defer fstest.MockStdin(t, "y")()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		require.NoError(t, afero.WriteFile(fsys, path, []byte("select 1"), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.TRUNCATE_VERSION_TABLE + `;INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES( '0' ,  'test' ,  '{select 1}' )`).
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
		defer fstest.MockStdin(t, "y")()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		pgtest.MockMigrationHistory(conn)
		conn.Query(history.TRUNCATE_VERSION_TABLE).
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
		defer fstest.MockStdin(t, "y")()
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.MigrationsDir}
		// Run test
		err := Run(context.Background(), dbConfig, nil, Applied, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}

func TestMigrationFile(t *testing.T) {
	t.Run("new from file sets max token", func(t *testing.T) {
		viper.Reset()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20220727064247_create_table.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "BEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		migration, err := NewMigrationFromFile(path, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Len(t, migration.Lines, 2)
		assert.Equal(t, "20220727064247", migration.Version)
	})

	t.Run("new from reader errors on max token", func(t *testing.T) {
		viper.Reset()
		sql := "\tBEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		// Run test
		migration, err := NewMigrationFromReader(strings.NewReader(sql))
		// Check error
		assert.ErrorIs(t, err, bufio.ErrTooLong)
		assert.ErrorContains(t, err, "After statement 1: \tBEGIN;")
		assert.Nil(t, migration)
	})

	t.Run("encodes statements in binary format", func(t *testing.T) {
		migration := MigrationFile{
			Lines:   []string{"create schema public"},
			Version: "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Lines[0]).
			Reply("CREATE SCHEMA").
			Query(history.INSERT_MIGRATION_VERSION, "0", "", migration.Lines).
			Reply("INSERT 0 1")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectByConfig(ctx, dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = migration.ExecBatch(context.Background(), mock)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		migration := MigrationFile{
			Lines:   []string{"create schema public"},
			Version: "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Lines[0]).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`).
			Query(history.INSERT_MIGRATION_VERSION, "0", "", fmt.Sprintf("{%s}", migration.Lines[0])).
			Reply("INSERT 0 1")
		// Connect to mock via text protocol
		ctx := context.Background()
		mock, err := utils.ConnectByConfig(ctx, dbConfig, conn.Intercept, func(cc *pgx.ConnConfig) {
			cc.PreferSimpleProtocol = true
		})
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = migration.ExecBatch(context.Background(), mock)
		// Check error
		assert.ErrorContains(t, err, "ERROR: schema \"public\" already exists (SQLSTATE 42P06)")
		assert.ErrorContains(t, err, "At statement 0: create schema public")
	})
}
