package history

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils/pgxv5"
)

const (
	SET_LOCK_TIMEOUT         = "SET LOCAL lock_timeout = '4s'"
	CREATE_VERSION_SCHEMA    = "CREATE SCHEMA IF NOT EXISTS supabase_migrations"
	CREATE_VERSION_TABLE     = "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)"
	ADD_STATEMENTS_COLUMN    = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]"
	ADD_NAME_COLUMN          = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text"
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)"
	DELETE_MIGRATION_VERSION = "DELETE FROM supabase_migrations.schema_migrations WHERE version = ANY($1)"
	DELETE_MIGRATION_BEFORE  = "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1"
	TRUNCATE_VERSION_TABLE   = "TRUNCATE supabase_migrations.schema_migrations"
	SELECT_VERSION_TABLE     = "SELECT * FROM supabase_migrations.schema_migrations"
)

type SchemaMigration struct {
	Version    string
	Name       string
	Statements []string
}

func CreateMigrationTable(ctx context.Context, conn *pgx.Conn) error {
	// This must be run without prepared statements because each statement in the batch depends on
	// the previous schema change. The lock timeout will be reset when implicit transaction ends.
	batch := pgconn.Batch{}
	batch.ExecParams(SET_LOCK_TIMEOUT, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_TABLE, nil, nil, nil, nil)
	batch.ExecParams(ADD_STATEMENTS_COLUMN, nil, nil, nil, nil)
	batch.ExecParams(ADD_NAME_COLUMN, nil, nil, nil, nil)
	if _, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		return errors.Errorf("failed to create migration table: %w", err)
	}
	return nil
}

func ReadMigrationTable(ctx context.Context, conn *pgx.Conn) ([]SchemaMigration, error) {
	rows, err := conn.Query(ctx, SELECT_VERSION_TABLE)
	if err != nil {
		return nil, errors.Errorf("failed to read migration table: %w", err)
	}
	return pgxv5.CollectRows[SchemaMigration](rows)
}
