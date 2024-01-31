package history

import "github.com/jackc/pgconn"

const (
	CREATE_VERSION_SCHEMA    = "CREATE SCHEMA IF NOT EXISTS supabase_migrations"
	CREATE_VERSION_TABLE     = "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)"
	ADD_STATEMENTS_COLUMN    = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]"
	ADD_NAME_COLUMN          = "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text"
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)"
	DELETE_MIGRATION_VERSION = "DELETE FROM supabase_migrations.schema_migrations WHERE version = ANY($1)"
	DELETE_MIGRATION_BEFORE  = "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1"
	TRUNCATE_VERSION_TABLE   = "TRUNCATE supabase_migrations.schema_migrations"
)

func AddCreateTableStatements(batch *pgconn.Batch) {
	// Create history table if not exists
	batch.ExecParams(CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_TABLE, nil, nil, nil, nil)
	batch.ExecParams(ADD_STATEMENTS_COLUMN, nil, nil, nil, nil)
	batch.ExecParams(ADD_NAME_COLUMN, nil, nil, nil, nil)
}
