package pgtest

import (
	"github.com/supabase/cli/internal/migration/history"
)

func MockMigrationHistory(conn *MockConn) {
	conn.Query(history.CREATE_VERSION_SCHEMA).
		Reply("CREATE SCHEMA").
		Query(history.CREATE_VERSION_TABLE).
		Reply("CREATE TABLE").
		Query(history.ADD_STATEMENTS_COLUMN).
		Reply("ALTER TABLE").
		Query(history.ADD_NAME_COLUMN).
		Reply("ALTER TABLE")
}
