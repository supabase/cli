package repair

import (
	"bufio"
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
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
		require.NoError(t, afero.WriteFile(fsys, path, []byte(""), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(ADD_NAME_COLUMN).
			Reply("ALTER TABLE").
			Query(INSERT_MIGRATION_VERSION, "0", "test", "{}").
			Reply("INSERT 0 1")
		// Run test
		err := Run(context.Background(), dbConfig, "0", Applied, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("reverts old version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(ADD_NAME_COLUMN).
			Reply("ALTER TABLE").
			Query(DELETE_MIGRATION_VERSION, "0").
			Reply("DELETE 1")
		// Run test
		err := Run(context.Background(), dbConfig, "0", Reverted, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), pgconn.Config{}, "0", Applied, fsys)
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
		conn.Query(CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(ADD_NAME_COLUMN).
			Reply("ALTER TABLE").
			Query(INSERT_MIGRATION_VERSION, "0", "test", "{}").
			ReplyError(pgerrcode.DuplicateObject, `relation "supabase_migrations.schema_migrations" does not exist`)
		// Run test
		err := Run(context.Background(), dbConfig, "0", Applied, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, `ERROR: relation "supabase_migrations.schema_migrations" does not exist (SQLSTATE 42710)`)
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
			Query(INSERT_MIGRATION_VERSION, "0", "", fmt.Sprintf("{%s}", migration.Lines[0]))
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Port: 5432}, conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = migration.ExecBatch(context.Background(), mock)
		// Check error
		assert.ErrorContains(t, err, "ERROR: schema \"public\" already exists (SQLSTATE 42P06)")
		assert.ErrorContains(t, err, "At statement 0: create schema public")
	})
}
