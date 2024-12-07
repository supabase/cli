package helper

import (
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
)

func MockMigrationHistory(conn *pgtest.MockConn) *pgtest.MockConn {
	conn.Query(migration.SET_LOCK_TIMEOUT).
		Query(migration.CREATE_VERSION_SCHEMA).
		Reply("CREATE SCHEMA").
		Query(migration.CREATE_VERSION_TABLE).
		Reply("CREATE TABLE").
		Query(migration.ADD_STATEMENTS_COLUMN).
		Reply("ALTER TABLE").
		Query(migration.ADD_NAME_COLUMN).
		Reply("ALTER TABLE")
	return conn
}

func MockSeedHistory(conn *pgtest.MockConn) *pgtest.MockConn {
	conn.Query(migration.SET_LOCK_TIMEOUT).
		Query(migration.CREATE_VERSION_SCHEMA).
		Reply("CREATE SCHEMA").
		Query(migration.CREATE_SEED_TABLE).
		Reply("CREATE TABLE")
	return conn
}
