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

	t.Run("new from folder-based migration", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{
			"20242409125510_premium_mister_fear/migration.sql": &fs.MapFile{Data: []byte("CREATE TABLE foo (id int)")},
			"20242409125510_premium_mister_fear/snapshot.json":  &fs.MapFile{Data: []byte("{}")},
		}
		// Run test
		migration, err := NewMigrationFromFile("20242409125510_premium_mister_fear/migration.sql", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "20242409125510", migration.Version)
		assert.Equal(t, "premium_mister_fear", migration.Name)
		assert.Len(t, migration.Statements, 1)
	})

	t.Run("skips hint for schema-qualified type errors", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{"CREATE TABLE test (path extensions.ltree NOT NULL)"},
			Version:    "0",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			ReplyError("42704", `type "extensions.ltree" does not exist`).
			Query(INSERT_MIGRATION_VERSION, "0", "", migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error - should NOT contain hint since type is already schema-qualified
		assert.ErrorContains(t, err, `type "extensions.ltree" does not exist`)
		assert.NotContains(t, err.Error(), "Hint: This type may be defined in a schema")
	})
}

func TestExtractTypeName(t *testing.T) {
	t.Run("extracts type name from standard error message", func(t *testing.T) {
		result := extractTypeName(`type "ltree" does not exist`)
		assert.Equal(t, "ltree", result)
	})

	t.Run("extracts schema-qualified type name", func(t *testing.T) {
		result := extractTypeName(`type "extensions.ltree" does not exist`)
		assert.Equal(t, "extensions.ltree", result)
	})

	t.Run("extracts type with underscores", func(t *testing.T) {
		result := extractTypeName(`type "my_custom_type" does not exist`)
		assert.Equal(t, "my_custom_type", result)
	})

	t.Run("returns empty string for non-matching message", func(t *testing.T) {
		result := extractTypeName(`column "name" does not exist`)
		assert.Equal(t, "", result)
	})

	t.Run("returns empty string for empty message", func(t *testing.T) {
		result := extractTypeName("")
		assert.Equal(t, "", result)
	})

	t.Run("handles type names with numbers", func(t *testing.T) {
		result := extractTypeName(`type "type123" does not exist`)
		assert.Equal(t, "type123", result)
	})
}

func TestIsSchemaQualified(t *testing.T) {
	assert.True(t, IsSchemaQualified("extensions.ltree"))
	assert.True(t, IsSchemaQualified("public.my_type"))
	assert.False(t, IsSchemaQualified("ltree"))
	assert.False(t, IsSchemaQualified(""))
}

func TestParseVersion(t *testing.T) {
	t.Run("extracts version from flat file", func(t *testing.T) {
		version, name, ok := ParseVersion("20220727064247_create_table.sql")
		assert.True(t, ok)
		assert.Equal(t, "20220727064247", version)
		assert.Equal(t, "create_table", name)
	})

	t.Run("extracts version from flat file with path", func(t *testing.T) {
		version, name, ok := ParseVersion("supabase/migrations/20220727064247_create_table.sql")
		assert.True(t, ok)
		assert.Equal(t, "20220727064247", version)
		assert.Equal(t, "create_table", name)
	})

	t.Run("extracts version from folder-based migration", func(t *testing.T) {
		version, name, ok := ParseVersion("supabase/migrations/20242409125510_premium_mister_fear/migration.sql")
		assert.True(t, ok)
		assert.Equal(t, "20242409125510", version)
		assert.Equal(t, "premium_mister_fear", name)
	})

	t.Run("extracts version from folder-based migration without parent path", func(t *testing.T) {
		version, name, ok := ParseVersion("20242409125510_premium_mister_fear/migration.sql")
		assert.True(t, ok)
		assert.Equal(t, "20242409125510", version)
		assert.Equal(t, "premium_mister_fear", name)
	})

	t.Run("returns false for non-matching path", func(t *testing.T) {
		_, _, ok := ParseVersion("random_file.txt")
		assert.False(t, ok)
	})

	t.Run("returns false for migration.sql without matching parent dir", func(t *testing.T) {
		_, _, ok := ParseVersion("some_dir/migration.sql")
		assert.False(t, ok)
	})
}

func TestMigrationName(t *testing.T) {
	t.Run("returns filename for flat migration", func(t *testing.T) {
		assert.Equal(t, "20220727064247_create_table.sql", MigrationName("supabase/migrations/20220727064247_create_table.sql"))
	})

	t.Run("returns dir/file for folder-based migration", func(t *testing.T) {
		assert.Equal(t,
			"20242409125510_premium_mister_fear/migration.sql",
			MigrationName("supabase/migrations/20242409125510_premium_mister_fear/migration.sql"),
		)
	})

	t.Run("returns filename when no parent directory", func(t *testing.T) {
		assert.Equal(t, "20220727064247_create_table.sql", MigrationName("20220727064247_create_table.sql"))
	})
}
