package dump

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/migration"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestDumpCommand(t *testing.T) {
	imageUrl := utils.GetRegistryImageUrl(utils.Config.Db.Image)
	const containerId = "test-container"

	t.Run("pulls from remote", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), "schema.sql", dbConfig, false, false, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Validate migration
		contents, err := afero.ReadFile(fsys, "schema.sql")
		assert.NoError(t, err)
		assert.Equal(t, []byte("hello world"), contents)
	})

	t.Run("writes to stdout", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world\n"))
		// Run test
		err := Run(context.Background(), "", dbConfig, false, false, false, fsys, migration.WithSchema("public"))
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("suggests ipv4 pooler on ipv6 dump failure", func(t *testing.T) {
		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerErrorLogs(utils.Docker, containerId, 1,
			`pg_dump: error: could not translate host name "db.test.supabase.co" to address: No address associated with hostname`))
		// Run test
		err := Run(context.Background(), "", dbConfig, false, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Contains(t, utils.CmdSuggestion, "Your network does not support IPv6")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("suggests ipv4 pooler when pg_dump cannot assign ipv6 address", func(t *testing.T) {
		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })
		fsys := afero.NewMemMapFs()
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerErrorLogs(utils.Docker, containerId, 1,
			`pg_dump: error: connection to server at "db.test.supabase.co" (2600:1f1c:c19:4901:963f:d22e:683a:381c), port 5432 failed: Cannot assign requested address`))
		err := Run(context.Background(), "", dbConfig, false, false, false, fsys)
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Contains(t, utils.CmdSuggestion, "Your network does not support IPv6")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("retries via ipv4 pooler on ipv6 dump failure", func(t *testing.T) {
		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })
		// Auto-retry only applies to the linked path, not explicit --db-url.
		flags.PoolerFallbackEligible = true
		t.Cleanup(func() { flags.PoolerFallbackEligible = false })
		// Stub pooler resolution so the retry path does not touch the network.
		orig := resolvePoolerFallback
		resolvePoolerFallback = func(ctx context.Context, projectRef string) (pgconn.Config, error) {
			return pgconn.Config{
				Host:     "aws-0-us-east-1.pooler.supabase.com",
				Port:     5432,
				User:     "postgres." + projectRef,
				Password: "secret",
				Database: "postgres",
			}, nil
		}
		t.Cleanup(func() { resolvePoolerFallback = orig })
		// Capture stderr to assert the user-visible fallback warning.
		oldStderr := os.Stderr
		r, w, err := os.Pipe()
		require.NoError(t, err)
		os.Stderr = w
		stderr := make(chan string, 1)
		go func() {
			var buf bytes.Buffer
			_, _ = io.Copy(&buf, r)
			stderr <- buf.String()
		}()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// First container run fails because the direct host is unreachable over IPv6.
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerErrorLogs(utils.Docker, containerId, 1,
			`pg_dump: error: could not translate host name "db.bvkmtbubamprwkclmslb.supabase.co" to address: No address associated with hostname`))
		// Retry through the pooler succeeds.
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		directConfig := pgconn.Config{
			Host:     "db.bvkmtbubamprwkclmslb.supabase.co",
			Port:     5432,
			User:     "postgres",
			Password: "password",
			Database: "postgres",
		}
		err = Run(context.Background(), "schema.sql", directConfig, false, false, false, fsys)
		require.NoError(t, w.Close())
		os.Stderr = oldStderr
		// Check error
		require.NoError(t, err)
		assert.Empty(t, utils.CmdSuggestion)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Validate the retry wrote the full dump after truncating the failed attempt.
		contents, err := afero.ReadFile(fsys, "schema.sql")
		require.NoError(t, err)
		assert.Equal(t, []byte("hello world"), contents)
		// Validate the user saw the fallback warning.
		assert.Contains(t, <-stderr, "Retrying via the IPv4 connection pooler")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "", dbConfig, false, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "request returned 503 Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world\n"))
		// Run test
		err := Run(context.Background(), "schema.sql", dbConfig, false, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPoolerFallbackConfig(t *testing.T) {
	ipv6Err := errors.New(`could not translate host name "db.bvkmtbubamprwkclmslb.supabase.co" to address: No address associated with hostname`)
	directConfig := pgconn.Config{Host: "db.bvkmtbubamprwkclmslb.supabase.co", Port: 5432}

	stubResolver := func(cfg pgconn.Config, err error) func() {
		orig := resolvePoolerFallback
		resolvePoolerFallback = func(context.Context, string) (pgconn.Config, error) { return cfg, err }
		return func() { resolvePoolerFallback = orig }
	}
	withEligible := func(v bool) func() {
		orig := flags.PoolerFallbackEligible
		flags.PoolerFallbackEligible = v
		return func() { flags.PoolerFallbackEligible = orig }
	}

	t.Run("resolves pooler for eligible linked ipv6 failure", func(t *testing.T) {
		t.Cleanup(withEligible(true))
		pooler := pgconn.Config{Host: "aws-0-us-east-1.pooler.supabase.com", Port: 5432}
		t.Cleanup(stubResolver(pooler, nil))
		got, ok := PoolerFallbackConfig(context.Background(), directConfig, ipv6Err)
		assert.True(t, ok)
		assert.Equal(t, pooler.Host, got.Host)
	})

	t.Run("never reroutes explicit --db-url targets", func(t *testing.T) {
		t.Cleanup(withEligible(false))
		t.Cleanup(stubResolver(pgconn.Config{}, errors.New("resolver must not be called")))
		_, ok := PoolerFallbackConfig(context.Background(), directConfig, ipv6Err)
		assert.False(t, ok)
	})

	t.Run("ignores non-ipv6 failures", func(t *testing.T) {
		t.Cleanup(withEligible(true))
		t.Cleanup(stubResolver(pgconn.Config{}, errors.New("resolver must not be called")))
		_, ok := PoolerFallbackConfig(context.Background(), directConfig, errors.New("permission denied for table"))
		assert.False(t, ok)
	})

	t.Run("ignores non-direct hosts", func(t *testing.T) {
		t.Cleanup(withEligible(true))
		t.Cleanup(stubResolver(pgconn.Config{}, errors.New("resolver must not be called")))
		_, ok := PoolerFallbackConfig(context.Background(), pgconn.Config{Host: "aws-0-us-east-1.pooler.supabase.com"}, ipv6Err)
		assert.False(t, ok)
	})

	t.Run("returns false when pooler resolution fails", func(t *testing.T) {
		t.Cleanup(withEligible(true))
		t.Cleanup(stubResolver(pgconn.Config{}, errors.New("no pooler")))
		_, ok := PoolerFallbackConfig(context.Background(), directConfig, ipv6Err)
		assert.False(t, ok)
	})
}
