package migration

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/apps/cli-go/pkg/pgtest"
)

func TestRevokeDefaultDataApiPrivileges(t *testing.T) {
	t.Run("revokes default data api privileges", func(t *testing.T) {
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("alter default privileges for role postgres in schema public\n  revoke select, insert, update, delete on tables from anon, authenticated, service_role").
			Reply("ALTER DEFAULT PRIVILEGES").
			Query("alter default privileges for role postgres in schema public\n  revoke usage, select on sequences from anon, authenticated, service_role").
			Reply("ALTER DEFAULT PRIVILEGES").
			Query("alter default privileges for role postgres in schema public\n  revoke execute on functions from anon, authenticated, service_role").
			Reply("ALTER DEFAULT PRIVILEGES")
		client := conn.MockClient(t)
		err := RevokeDefaultDataApiPrivileges(context.Background(), client)
		assert.NoError(t, err)
	})
}
