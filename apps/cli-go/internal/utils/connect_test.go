package utils

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils/cloudflare"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     GetSupabaseDbHost(apitest.RandomProjectRef()),
	Port:     6543,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

var (
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
	oldProfile := CurrentProfile
	CurrentProfile = allProfiles[0]
	defer t.Cleanup(func() { CurrentProfile = oldProfile })

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

func TestSetConnectSuggestion(t *testing.T) {
	oldProfile := CurrentProfile
	CurrentProfile = allProfiles[0]
	defer t.Cleanup(func() { CurrentProfile = oldProfile })

	cases := []struct {
		name       string
		err        error
		suggestion string
		debug      bool
	}{
		{
			name:       "no-op on nil error",
			err:        nil,
			suggestion: "",
		},
		{
			name:       "no-op on unrecognised error",
			err:        errors.New("some unknown error"),
			suggestion: "",
		},
		{
			name:       "connection refused",
			err:        errors.New("connect: connection refused"),
			suggestion: "Make sure your local IP is allowed in Network Restrictions and Network Bans",
		},
		{
			name:       "address not in allow list",
			err:        errors.New("server error (FATAL: Address not in tenant allow_list: {1,2,3} (SQLSTATE XX000))"),
			suggestion: "Make sure your local IP is allowed in Network Restrictions and Network Bans",
		},
		{
			name:       "ssl required without debug flag",
			err:        errors.New("SSL connection is required"),
			suggestion: "",
		},
		{
			name:       "ssl required with debug flag",
			err:        errors.New("SSL connection is required"),
			debug:      true,
			suggestion: "SSL connection is not supported with --debug flag",
		},
		{
			name:       "wrong password via SCRAM",
			err:        errors.New("SCRAM exchange: Wrong password"),
			suggestion: "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD",
		},
		{
			name:       "failed SASL auth",
			err:        errors.New("failed SASL auth"),
			suggestion: "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD",
		},
		{
			name:       "ipv6 no route to host",
			err:        errors.New("dial tcp [2406:da18:4fd:9b0d:80ec:9812:3e65:450b]:5432: connect: no route to host"),
			suggestion: "Your network does not support IPv6",
		},
		{
			name:       "ipv6 network is unreachable",
			err:        errors.New("dial tcp [2406:da18:4fd:9b0d:80ec:9812:3e65:450b]:5432: connect: network is unreachable"),
			suggestion: "Your network does not support IPv6",
		},
		{
			name:       "libpq unsupported address family",
			err:        errors.New(`pg_dump: error: connection to server failed: could not translate host name "db.test.supabase.co" to address: Address family for hostname not supported`),
			suggestion: "Your network does not support IPv6",
		},
		{
			name:       "libpq no address associated with hostname",
			err:        errors.New(`pg_dump: error: could not translate host name "db.ngpopfcjxrfmzmhmmpct.supabase.co" to address: No address associated with hostname`),
			suggestion: "Your network does not support IPv6",
		},
		{
			name:       "libpq network is unreachable without literal",
			err:        errors.New(`connection to server at "db.test.supabase.co", port 5432 failed: Network is unreachable`),
			suggestion: "Your network does not support IPv6",
		},
		{
			name: "libpq cannot assign requested address",
			err: errors.New(`pg_dump: error: connection to server at "db.test.supabase.co" (2600:1f1c:c19:4901:963f:d22e:683a:381c), port 5432 failed: Cannot assign requested address
	Is the server running on that host and accepting TCP/IP connections?`),
			suggestion: "Your network does not support IPv6",
		},
		{
			name:       "cannot assign requested address without ipv6 literal",
			err:        errors.New("connect: cannot assign requested address"),
			suggestion: "",
		},
		{
			name:       "no route to host without ipv6 address",
			err:        errors.New("connect: no route to host"),
			suggestion: "Make sure your project exists on profile: " + CurrentProfile.Name,
		},
		{
			name:       "tenant or user not found",
			err:        errors.New("Tenant or user not found"),
			suggestion: "Make sure your project exists on profile: " + CurrentProfile.Name,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			CmdSuggestion = ""
			viper.Set("DEBUG", tc.debug)
			SetConnectSuggestion(tc.err)
			if tc.suggestion == "" {
				assert.Empty(t, CmdSuggestion)
			} else {
				assert.Contains(t, CmdSuggestion, tc.suggestion)
			}
		})
	}
}

func TestSuggestIPv6Pooler(t *testing.T) {
	ref := apitest.RandomProjectRef()
	poolerURL := "postgres://postgres." + ref + ":[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres"

	t.Run("enriches suggestion with transaction pooler url", func(t *testing.T) {
		CmdSuggestion = ""
		t.Cleanup(func() { CmdSuggestion = "" })
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref + "/config/database/pooler").
			Reply(http.StatusOK).
			JSON([]api.SupavisorConfigResponse{{
				DatabaseType:     api.SupavisorConfigResponseDatabaseTypePRIMARY,
				ConnectionString: poolerURL,
			}})
		ok := SuggestIPv6Pooler(context.Background(), "db."+ref+".supabase.co")
		assert.True(t, ok)
		assert.Contains(t, CmdSuggestion, "--db-url")
		assert.Contains(t, CmdSuggestion, poolerURL)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("masks a real password returned by the api", func(t *testing.T) {
		CmdSuggestion = ""
		t.Cleanup(func() { CmdSuggestion = "" })
		t.Cleanup(apitest.MockPlatformAPI(t))
		secretURL := "postgres://postgres." + ref + ":sup3r-s3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref + "/config/database/pooler").
			Reply(http.StatusOK).
			JSON([]api.SupavisorConfigResponse{{
				DatabaseType:     api.SupavisorConfigResponseDatabaseTypePRIMARY,
				ConnectionString: secretURL,
			}})
		ok := SuggestIPv6Pooler(context.Background(), "db."+ref+".supabase.co")
		assert.True(t, ok)
		assert.NotContains(t, CmdSuggestion, "sup3r-s3cret")
		assert.Contains(t, CmdSuggestion, "[YOUR-PASSWORD]")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips non-supabase host without api call", func(t *testing.T) {
		CmdSuggestion = ""
		assert.False(t, SuggestIPv6Pooler(context.Background(), "localhost"))
		assert.Empty(t, CmdSuggestion)
	})

	t.Run("returns false when pooler config is unavailable", func(t *testing.T) {
		CmdSuggestion = ""
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(DefaultApiHost).
			Get("/v1/projects/" + ref + "/config/database/pooler").
			Reply(http.StatusOK).
			JSON([]api.SupavisorConfigResponse{})
		assert.False(t, SuggestIPv6Pooler(context.Background(), "db."+ref+".supabase.co"))
		assert.Empty(t, CmdSuggestion)
	})
}

func TestProjectRefFromDirectDbHost(t *testing.T) {
	ref := apitest.RandomProjectRef()

	t.Run("extracts ref from direct host", func(t *testing.T) {
		got, ok := ProjectRefFromDirectDbHost("db." + ref + ".supabase.co")
		assert.True(t, ok)
		assert.Equal(t, ref, got)
	})

	t.Run("rejects pooler and local hosts", func(t *testing.T) {
		for _, host := range []string{
			"aws-0-us-east-1.pooler.supabase.com",
			"localhost",
			"127.0.0.1",
			"db." + ref + ".supabase.net",
		} {
			_, ok := ProjectRefFromDirectDbHost(host)
			assert.False(t, ok, host)
		}
	})
}

func TestWarnIPv6PoolerFallback(t *testing.T) {
	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	require.NoError(t, err)
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = oldStderr })

	WarnIPv6PoolerFallback("db.test.supabase.co")
	require.NoError(t, w.Close())
	out, err := io.ReadAll(r)
	require.NoError(t, err)

	assert.Contains(t, string(out), "db.test.supabase.co")
	assert.Contains(t, string(out), "does not support IPv6")
	assert.Contains(t, string(out), "connection pooler")
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

func TestPostgresURLWithoutPassword(t *testing.T) {
	config := pgconn.Config{
		Host:     "2406:da18:4fd:9b0d:80ec:9812:3e65:450b",
		Port:     5432,
		User:     "postgres",
		Password: "!@#$%^&*()",
		RuntimeParams: map[string]string{
			"options": "test",
		},
	}
	url := ToPostgresURLWithoutPassword(config)
	// Same as ToPostgresURL but with the password omitted from the userinfo, so a
	// credential is never written to stdout by the db __shadow seam.
	assert.Equal(t, `postgresql://postgres@[2406:da18:4fd:9b0d:80ec:9812:3e65:450b]:5432/?connect_timeout=10&options=test`, url)
	assert.NotContains(t, url, "%21%40%23")
}
