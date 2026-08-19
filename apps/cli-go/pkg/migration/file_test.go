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

	t.Run("executes pipeline incompatible statements outside batch", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{
				"create table public.widgets(id bigint primary key)",
				"CREATE UNIQUE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
				"alter table public.widgets enable row level security",
			},
			Version: "20260101000000",
			Name:    "create_widgets",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			Reply("CREATE TABLE").
			SimpleQuery(migration.Statements[1]).
			Reply("CREATE INDEX").
			Query(migration.Statements[2]).
			Reply("ALTER TABLE").
			Query(INSERT_MIGRATION_VERSION, migration.Version, migration.Name, migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
	})

	t.Run("records migration version when file has no statements", func(t *testing.T) {
		migration := MigrationFile{
			Version: "20260101000000",
			Name:    "empty_migration",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(INSERT_MIGRATION_VERSION, migration.Version, migration.Name, migration.Statements).
			Reply("INSERT 0 1")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
	})

	t.Run("reports pipeline incompatible statement errors with statement index", func(t *testing.T) {
		migration := MigrationFile{
			Statements: []string{
				"create table public.widgets(id bigint primary key)",
				"CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
				"alter table public.widgets enable row level security",
			},
			Version: "20260101000000",
			Name:    "create_widgets",
		}
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.Statements[0]).
			Reply("CREATE TABLE").
			SimpleQuery(migration.Statements[1]).
			ReplyError("25001", "CREATE INDEX CONCURRENTLY cannot be executed within a pipeline")
		// Run test
		err := migration.ExecBatch(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "ERROR: CREATE INDEX CONCURRENTLY cannot be executed within a pipeline (SQLSTATE 25001)")
		assert.ErrorContains(t, err, "At statement: 1\nCREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)")
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

func TestIsPipelineIncompatible(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		{
			name: "create index concurrently",
			sql:  "CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
			want: true,
		},
		{
			name: "create unique index concurrently",
			sql:  "CREATE UNIQUE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
			want: true,
		},
		{
			name: "create index concurrently after comments",
			sql:  "-- cannot run in a transaction\n/* generated */\nCREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
			want: true,
		},
		{
			name: "drop index concurrently",
			sql:  "DROP INDEX CONCURRENTLY public.widgets_id_idx",
			want: true,
		},
		{
			name: "drop index concurrently if exists",
			sql:  "drop index concurrently if exists api.idx_rx_orders_clinic_id",
			want: true,
		},
		{
			name: "reindex table concurrently",
			sql:  "REINDEX TABLE CONCURRENTLY public.widgets",
			want: true,
		},
		{
			name: "reindex with options concurrently",
			sql:  "REINDEX (VERBOSE) INDEX CONCURRENTLY widgets_id_idx",
			want: true,
		},
		{
			name: "vacuum bare",
			sql:  "VACUUM",
			want: true,
		},
		{
			name: "vacuum with options",
			sql:  "VACUUM (ANALYZE) public.widgets",
			want: true,
		},
		{
			name: "alter system",
			sql:  "ALTER SYSTEM SET log_statement = 'all'",
			want: true,
		},
		{
			name: "cluster",
			sql:  "CLUSTER public.widgets USING widgets_id_idx",
			want: true,
		},
		{
			name: "ordinary create index",
			sql:  "CREATE INDEX widgets_id_idx ON public.widgets(id)",
			want: false,
		},
		{
			name: "ordinary drop index",
			sql:  "DROP INDEX IF EXISTS public.widgets_id_idx",
			want: false,
		},
		{
			name: "concurrently in string literal",
			sql:  "SELECT 'CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)'",
			want: false,
		},
		{
			name: "concurrently in leading comment only",
			sql:  "-- CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)\nSELECT 1",
			want: false,
		},
		{
			name: "word prefix",
			sql:  "VACUUMING public.widgets",
			want: false,
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, isPipelineIncompatible(tt.sql))
		})
	}
}

func TestIsSchemaQualified(t *testing.T) {
	assert.True(t, IsSchemaQualified("extensions.ltree"))
	assert.True(t, IsSchemaQualified("public.my_type"))
	assert.False(t, IsSchemaQualified("ltree"))
	assert.False(t, IsSchemaQualified(""))
}
