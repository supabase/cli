package apply

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

func TestMigrateDatabase(t *testing.T) {
	t.Run("applies local migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(utils.MigrationsDir, "0_test.sql")
		sql := "create schema public"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(sql), 0644))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(sql).
			Reply("CREATE SCHEMA")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = MigrateDatabase(ctx, mock, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("ignores empty local directory", func(t *testing.T) {
		assert.NoError(t, MigrateDatabase(context.Background(), nil, afero.NewMemMapFs()))
	})

	t.Run("ignores outdated migrations", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup initial migration
		name := "20211208000000_init.sql"
		path := filepath.Join(utils.MigrationsDir, name)
		query := "create table test"
		require.NoError(t, afero.WriteFile(fsys, path, []byte(query), 0644))
		// Run test
		err := MigrateDatabase(context.Background(), nil, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := MigrateDatabase(context.Background(), nil, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on open failure", func(t *testing.T) {
		path := filepath.Join(utils.MigrationsDir, "20220727064247_create_table.sql")
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: path}
		_, err := fsys.MemMapFs.Create(path)
		require.NoError(t, err)
		// Run test
		err = MigrateDatabase(context.Background(), nil, fsys)
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
		assert.Equal(t, "20220727064247", migration.version)
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
			version: "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Lines[0]).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`).
			Query(repair.INSERT_MIGRATION_VERSION, "0")
		// Connect to mock
		ctx := context.Background()
		mock, err := utils.ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		err = migration.ExecBatch(context.Background(), mock)
		// Check error
		assert.ErrorContains(t, err, "ERROR: schema \"public\" already exists (SQLSTATE 42P06)")
		assert.ErrorContains(t, err, "At statement 0: create schema public")
	})
}
