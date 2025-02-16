package migration

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/pgxv5"
)

const (
	SET_LOCK_TIMEOUT         = "SET lock_timeout = '4s'"
	CREATE_VERSION_SCHEMA    = "CREATE SCHEMA IF NOT EXISTS supabase_migrations"
	CREATE_VERSION_TABLE     = "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)"
	ADD_STATEMENTS_COLUMN    = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]"
	ADD_NAME_COLUMN          = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text"
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)"
	DELETE_MIGRATION_VERSION = "DELETE FROM supabase_migrations.schema_migrations WHERE version = ANY($1)"
	DELETE_MIGRATION_BEFORE  = "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1"
	TRUNCATE_VERSION_TABLE   = "TRUNCATE supabase_migrations.schema_migrations"
	SELECT_VERSION_TABLE     = "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations"
	LIST_MIGRATION_VERSION   = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"
	CREATE_SEED_TABLE        = "CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL)"
	UPSERT_SEED_FILE         = "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES($1, $2) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash"
	SELECT_SEED_TABLE        = "SELECT path, hash FROM supabase_migrations.seed_files"
)

// TODO: support overriding `supabase_migrations.schema_migrations` with user defined <schema>.<table>
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

func ReadMigrationTable(ctx context.Context, conn *pgx.Conn) ([]MigrationFile, error) {
	rows, err := conn.Query(ctx, SELECT_VERSION_TABLE)
	if err != nil {
		return nil, errors.Errorf("failed to read migration table: %w", err)
	}
	return pgxv5.CollectRows[MigrationFile](rows)
}

func CreateSeedTable(ctx context.Context, conn *pgx.Conn) error {
	// This must be run without prepared statements because each statement in the batch depends on
	// the previous schema change. The lock timeout will be reset when implicit transaction ends.
	batch := pgconn.Batch{}
	batch.ExecParams(SET_LOCK_TIMEOUT, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(CREATE_SEED_TABLE, nil, nil, nil, nil)
	if _, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		return errors.Errorf("failed to create seed table: %w", err)
	}
	return nil
}

func ReadSeedTable(ctx context.Context, conn *pgx.Conn) ([]SeedFile, error) {
	rows, err := conn.Query(ctx, SELECT_SEED_TABLE)
	if err != nil {
		return nil, errors.Errorf("failed to read seed table: %w", err)
	}
	return pgxv5.CollectRows[SeedFile](rows)
}
