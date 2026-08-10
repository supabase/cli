package helper

import "github.com/supabase/cli/pkg/pgtest"

// MockApiPrivilegesRevoke queues the per-statement responses for the default Data API privilege
// revoke that start.ApplyApiPrivileges runs when [api].auto_expose_new_tables is unset or false.
//
// The statements mirror start.RevokeDefaultDataApiPrivilegesSql. They are inlined here rather
// than imported from the start package to avoid an import cycle with that package's own
// internal (package start) tests.
func MockApiPrivilegesRevoke(conn *pgtest.MockConn) *pgtest.MockConn {
	conn.Query("alter default privileges for role postgres in schema public\n  revoke select, insert, update, delete on tables from anon, authenticated, service_role").
		Reply("ALTER DEFAULT PRIVILEGES").
		Query("alter default privileges for role postgres in schema public\n  revoke usage, select on sequences from anon, authenticated, service_role").
		Reply("ALTER DEFAULT PRIVILEGES").
		Query("alter default privileges for role postgres in schema public\n  revoke execute on functions from anon, authenticated, service_role").
		Reply("ALTER DEFAULT PRIVILEGES")
	return conn
}
