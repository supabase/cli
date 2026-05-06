package migration

import (
	"context"
	_ "embed"

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
		"pgmq",
		"pgsodium",
		"pgtle",
		`supabase\_migrations`,
		"vault",
	}
)

func DropUserSchemas(ctx context.Context, conn *pgx.Conn) error {
	migration := MigrationFile{}
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
