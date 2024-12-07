package utils

import (
	"context"
	"net"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils/cloudflare"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     GetSupabaseDbHost(apitest.RandomProjectRef()),
	Port:     6543,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

const (
	PG13_POOLER_URL = "postgres://postgres:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?options=reference%3Dzupyfdrjfhbeevcogohz"
	PG15_POOLER_URL = "postgres://postgres.zupyfdrjfhbeevcogohz:[YOUR-PASSWORD]@fly-0-sin.pooler.supabase.com:6543/postgres"
)

func TestConnectByConfig(t *testing.T) {
	t.Run("connects to remote postgres with DoH", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = ""
		DNSResolver.Value = DNS_OVER_HTTPS
		// Setup http mock
		defer gock.OffAll()
		// pgx makes 2 calls to resolve ip for each connect request
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&cloudflare.DNSResponse{Answer: []cloudflare.DNSAnswer{
				{Type: cloudflare.TypeA, Data: "127.0.0.1"},
			}})
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&cloudflare.DNSResponse{Answer: []cloudflare.DNSAnswer{
				{Type: cloudflare.TypeA, Data: "127.0.0.1"},
			}})
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		c, err := ConnectByConfig(context.Background(), dbConfig, conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.NoError(t, err)
	})

	t.Run("connects with unescaped db password", func(t *testing.T) {
		DNSResolver.Value = DNS_GO_NATIVE
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		config := *dbConfig.Copy()
		config.Host = "localhost"
		config.Password = "pass word"
		c, err := ConnectByConfig(context.Background(), config, conn.Intercept)
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.Equal(t, config.Password, c.Config().Password)
	})

	t.Run("no retry on connecting successfully with pooler", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = PG15_POOLER_URL
		DNSResolver.Value = DNS_GO_NATIVE
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		c, err := ConnectByConfig(context.Background(), dbConfig, conn.Intercept)
		// Check error
		require.NoError(t, err)
		defer c.Close(context.Background())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("fallback to postgres port on dial error", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = PG15_POOLER_URL
		DNSResolver.Value = DNS_OVER_HTTPS
		netErr := errors.New("network error")
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", dbConfig.Host).
			MatchHeader("accept", "application/dns-json").
			ReplyError(&net.OpError{Op: "dial", Err: netErr})
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "fly-0-sin.pooler.supabase.com").
			MatchHeader("accept", "application/dns-json").
			ReplyError(&net.OpError{Op: "dial", Err: netErr})
		// Run test
		_, err := ConnectByConfig(context.Background(), dbConfig)
		// Check error
		require.ErrorIs(t, err, netErr)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestConnectLocal(t *testing.T) {
	t.Run("connects with debug log", func(t *testing.T) {
		viper.Set("DEBUG", true)
		_, err := ConnectLocalPostgres(context.Background(), pgconn.Config{Host: "0", Port: 6543})
		assert.ErrorContains(t, err, "failed to connect to postgres")
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		Config.Db.Port = 0
		_, err := ConnectLocalPostgres(context.Background(), pgconn.Config{})
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})
}

func TestPoolerConfig(t *testing.T) {
	t.Run("parses options ref", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = PG13_POOLER_URL
		assert.NotNil(t, GetPoolerConfig("zupyfdrjfhbeevcogohz"))
	})

	t.Run("parses username ref", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = PG15_POOLER_URL
		assert.NotNil(t, GetPoolerConfig("zupyfdrjfhbeevcogohz"))
	})

	t.Run("returns nil on missing url", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = ""
		assert.Nil(t, GetPoolerConfig("zupyfdrjfhbeevcogohz"))
	})

	t.Run("returns nil on malformed url", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = "malformed"
		assert.Nil(t, GetPoolerConfig("zupyfdrjfhbeevcogohz"))
	})

	t.Run("returns nil on mismatched project", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = PG13_POOLER_URL
		assert.Nil(t, GetPoolerConfig("nlhaskwsizylhnffaqkd"))
		Config.Db.Pooler.ConnectionString = PG15_POOLER_URL
		assert.Nil(t, GetPoolerConfig("nlhaskwsizylhnffaqkd"))
	})

	t.Run("returns nil on invalid host", func(t *testing.T) {
		Config.Db.Pooler.ConnectionString = "postgres://postgres.zupyfdrjfhbeevcogohz:[YOUR-PASSWORD]@localhost:6543/postgres"
		assert.Nil(t, GetPoolerConfig("zupyfdrjfhbeevcogohz"))
	})
}

func TestPostgresURL(t *testing.T) {
	url := ToPostgresURL(pgconn.Config{
		Host:     "2406:da18:4fd:9b0d:80ec:9812:3e65:450b",
		Port:     5432,
		User:     "postgres",
		Password: "!@#$%^&*()",
		RuntimeParams: map[string]string{
			"options": "test",
		},
	})
	assert.Equal(t, `postgresql://postgres:%21%40%23$%25%5E&%2A%28%29@[2406:da18:4fd:9b0d:80ec:9812:3e65:450b]:5432/?connect_timeout=10&options=test`, url)
}
