package migration

import (
	"context"
	"testing"

	"github.com/jackc/pgerrcode"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

var escapedSchemas = append(ManagedSchemas, "extensions", "public")

func TestDropSchemas(t *testing.T) {
	t.Run("resets remote database", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ListSchemas, escapedSchemas).
			Reply("SELECT 1", []interface{}{"private"}).
			Query("DROP SCHEMA IF EXISTS private CASCADE").
			Reply("DROP SCHEMA").
			Query(DropObjects).
			Reply("INSERT 0")
		// Run test
		err := DropUserSchemas(context.Background(), conn.MockClient(t))
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on list schema failure", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ListSchemas, escapedSchemas).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation information_schema")
		// Run test
		err := DropUserSchemas(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation information_schema (SQLSTATE 42501)")
	})

	t.Run("throws error on drop schema failure", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(ListSchemas, escapedSchemas).
			Reply("SELECT 0").
			Query(DropObjects).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations")
		// Run test
		err := DropUserSchemas(context.Background(), conn.MockClient(t))
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}
