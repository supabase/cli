package debug

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestPostgresProxy(t *testing.T) {
	postgresURL := fmt.Sprintf("postgresql://%s@127.0.0.1:5432/postgres", "postgres")

	t.Run("forwards messages between frontend and backend", func(t *testing.T) {
		// Parse connection url
		config, err := pgx.ParseConfig(postgresURL)
		require.NoError(t, err)
		// Setup postgres mock
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Intercept(config)
		// Run test
		SetupPGX(config)
		ctx := context.Background()
		proxy, err := pgx.ConnectConfig(ctx, config)
		assert.NoError(t, err)
		assert.NoError(t, proxy.Close(ctx))
	})
}
