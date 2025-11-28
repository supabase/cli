package migration

import (
	"bufio"
	"context"
	"strings"
	"testing"
	fs "testing/fstest"

	"github.com/jackc/pgerrcode"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/parser"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestMigrationFile(t *testing.T) {
	t.Run("new from file sets max token", func(t *testing.T) {
		// Setup in-memory fs
		path := "20220727064247_create_table.sql"
		query := "BEGIN; " + strings.Repeat("a", parser.MaxScannerCapacity)
		fsys := fs.MapFS{
			path: &fs.MapFile{Data: []byte(query)},
		}
		// Run test
		migration, err := NewMigrationFromFile(path, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Len(t, migration.Statements, 2)
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
			Statements: []string{"create schema public"},
			Version:    "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			Reply("CREATE SCHEMA").
			Query(INSERT_MIGRATION_VERSION, "0", "", migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on insert failure", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{"create schema public"},
			Version:    "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			ReplyError(pgerrcode.DuplicateSchema, `schema "public" already exists`).
			Query(INSERT_MIGRATION_VERSION, "0", "", migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "ERROR: schema \"public\" already exists (SQLSTATE 42P06)")
		assert.ErrorContains(t, err, "At statement: 0\ncreate schema public")
	})

	t.Run("provides helpful hint for extension type errors", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{"CREATE TABLE test (path ltree NOT NULL)"},
			Version:    "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			ReplyError("42704", `type "ltree" does not exist`).
			Query(INSERT_MIGRATION_VERSION, "0", "", migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, `type "ltree" does not exist`)
		assert.ErrorContains(t, err, "Hint: This type may be defined in a schema")
		assert.ErrorContains(t, err, "extensions.ltree")
		assert.ErrorContains(t, err, "supabase migration new --help")
		assert.ErrorContains(t, err, "At statement: 0")
	})

	t.Run("provides generic hint when type name cannot be extracted", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{"CREATE TABLE test (id custom_type)"},
			Version:    "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			ReplyError("42704", `type does not exist`).
			Query(INSERT_MIGRATION_VERSION, "0", "", migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "type does not exist")
		assert.ErrorContains(t, err, "Hint: This type may be defined in a schema")
		assert.ErrorContains(t, err, "extensions.<type_name>")
		assert.ErrorContains(t, err, "supabase migration new --help")
	})
}
