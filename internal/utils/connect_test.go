package utils

import (
	"context"
	"testing"

	"github.com/spf13/viper"
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

func TestConnectLocal(t *testing.T) {
	t.Run("connects with debug log", func(t *testing.T) {
		viper.Set("DEBUG", true)
		_, err := ConnectLocalPostgres(context.Background(), "0", 5432, "postgres")
		assert.ErrorContains(t, err, "dial error (dial tcp 0.0.0.0:5432: connect: connection refused)")
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		_, err := ConnectLocalPostgres(context.Background(), "localhost", 0, "postgres")
		assert.ErrorContains(t, err, "invalid port (outside range)")
		_, err = ConnectLocalPostgres(context.Background(), "localhost", 65536, "postgres")
		assert.ErrorContains(t, err, `invalid port (strconv.ParseUint: parsing "65536": value out of range)`)
	})
}
