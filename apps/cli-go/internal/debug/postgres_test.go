package debug

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"

	"github.com/jackc/pgx/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestPostgresProxy(t *testing.T) {
	const postgresUrl = "postgresql://postgres:password@127.0.0.1:5432/postgres"

	t.Run("forwards messages between frontend and backend", func(t *testing.T) {
		// Parse connection url
		config, err := pgx.ParseConfig(postgresUrl)
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

	t.Run("negotiates TLS itself instead of downgrading", func(t *testing.T) {
		config, err := pgx.ParseConfig(postgresUrl + "?sslmode=require")
		require.NoError(t, err)
		require.NotNil(t, config.TLSConfig)
		// Run test
		SetupPGX(config)
		assert.Nil(t, config.TLSConfig)
		for _, fallback := range config.Fallbacks {
			assert.Nil(t, fallback.TLSConfig)
		}
		// A server refusing TLS must fail the dial, not continue in plaintext.
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		defer ln.Close()
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			request := make([]byte, 8)
			if _, err := io.ReadFull(conn, request); err != nil {
				return
			}
			assert.Equal(t, int32(sslRequestCode), int32(binary.BigEndian.Uint32(request[4:])))
			_, _ = conn.Write([]byte("N"))
		}()
		_, err = config.DialFunc(context.Background(), "tcp", ln.Addr().String())
		assert.ErrorContains(t, err, "server refused TLS connection")
	})
}
