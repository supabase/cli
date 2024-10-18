package migration

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/pgxv5"
)

var (
	//go:embed queries/drop.sql
	DropObjects string
	//go:embed queries/list.sql
	ListSchemas string

	// Initialised by postgres image and owned by postgres role
	ManagedSchemas = []string{
		`information\_schema`,
		`pg\_%`,
		`\_analytics`,
		`\_realtime`,
		`\_supavisor`,
		"pgbouncer",
		"pgsodium",
		"pgtle",
		`supabase\_migrations`,
		"vault",
	}
)

func DropUserSchemas(ctx context.Context, conn *pgx.Conn) error {
	// Only drop objects in extensions and public schema
	excludes := append(ManagedSchemas,
		"extensions",
		"public",
	)
	userSchemas, err := ListUserSchemas(ctx, conn, excludes...)
	if err != nil {
		return err
	}
	// Drop all user defined schemas
	migration := MigrationFile{}
	for _, schema := range userSchemas {
		sql := fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema)
		migration.Statements = append(migration.Statements, sql)
	}
	// If an extension uses a schema it doesn't create, dropping the schema will cascade to also
	// drop the extension. But if an extension creates its own schema, dropping the schema will
	// throw an error. Hence, we drop the extension instead so it cascades to its own schema.
	migration.Statements = append(migration.Statements, DropObjects)
	return migration.ExecBatch(ctx, conn)
}

func ListUserSchemas(ctx context.Context, conn *pgx.Conn, exclude ...string) ([]string, error) {
	if len(exclude) == 0 {
		exclude = ManagedSchemas
	}
	rows, err := conn.Query(ctx, ListSchemas, exclude)
	if err != nil {
		return nil, errors.Errorf("failed to list schemas: %w", err)
	}
	// TODO: show detail and hint from pgconn.PgError
	return pgxv5.CollectStrings(rows)
}

func DropUserPublication(ctx context.Context, conn *pgx.Conn) error {
	excludes := []string{"supabase_realtime"}
	userPublications, err := ListUserPublications(ctx, conn, excludes...)
	if err != nil {
		return err
	}

	// Drop all user defined publications
	migration := MigrationFile{}
	for _, publication := range userPublications {
		sql := fmt.Sprintf("DROP PUBLICATION %s", publication)
		migration.Statements = append(migration.Statements, sql)
	}
	return migration.ExecBatch(ctx, conn)
}

func ListUserPublications(ctx context.Context, conn *pgx.Conn, exclude ...string) ([]string, error) {
	query := `
		SELECT pubname
		FROM pg_publication
		WHERE pubname NOT LIKE ANY($1)
	`

	// Execute the query, passing the exclude slice as a single argument
	rows, err := conn.Query(ctx, query, exclude)
	if err != nil {
		return nil, fmt.Errorf("failed to list publications: %w", err)
	}

	// Collect results into a slice of strings
	return pgxv5.CollectStrings(rows)
}
