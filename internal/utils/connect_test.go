package utils

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     GetSupabaseDbHost(apitest.RandomProjectRef()),
	Port:     6543,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestConnectRemotePostgres(t *testing.T) {
	t.Run("connects to remote postgres successfully", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		c, err := ConnectRemotePostgres(context.Background(), dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.NoError(t, err)
	})

	t.Run("preserves db password", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		config := *dbConfig.Copy()
		config.Password = "pass word"
		c, err := ConnectRemotePostgres(context.Background(), config, conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.Equal(t, config.Password, c.Config().Password)
	})

	t.Run("fallback to postgres port on timeout", func(t *testing.T) {
		DNSResolver.Value = DNS_OVER_HTTPS
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		// pgx makes 2 calls to resolve ip for each connect request
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		c, err := ConnectRemotePostgres(context.Background(), dbConfig, conn.Intercept)
		// Check error
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestConnectLocal(t *testing.T) {
	t.Run("connects with debug log", func(t *testing.T) {
		viper.Set("DEBUG", true)
		_, err := ConnectLocalPostgres(context.Background(), pgconn.Config{Host: "0"})
		assert.ErrorContains(t, err, "connect: connection refused")
	})
}
