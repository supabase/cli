package migration

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v4"
)

// RevokeDefaultDataApiPrivilegesSql matches the SQL that Studio runs at cloud project creation
// when the "Default privileges for new entities" toggle is off. It removes the default GRANTs
// applied by the initial schema so newly-created entities in `public` owned by `postgres` are
// not exposed through the Data API roles until explicit GRANTs are issued.
const RevokeDefaultDataApiPrivilegesSql = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
`

// RevokeDefaultDataApiPrivileges removes the default Data API GRANTs on newly-created entities
// in the public schema. Call this before applying migrations so new tables do not inherit the
// bundled initial-schema privileges.
func RevokeDefaultDataApiPrivileges(ctx context.Context, conn *pgx.Conn) error {
	file, err := NewMigrationFromReader(strings.NewReader(RevokeDefaultDataApiPrivilegesSql))
	if err != nil {
		return err
	}
	return file.ExecBatch(ctx, conn)
}
