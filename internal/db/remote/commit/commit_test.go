package commit

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/pgtest"
)

func TestConnectRemotePostgres(t *testing.T) {
	t.Run("connects to remote postgres successfully", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Run test
		c, err := ConnectRemotePostgres(context.Background(), "username", "password", "database", "localhost", conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.NoError(t, err)
	})

	t.Run("preserves db password", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)

		// Run test
		password := "pass word"
		c, err := ConnectRemotePostgres(context.Background(), "username", password, "database", "localhost", conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.Equal(t, password, c.Config().Password)
	})
}
