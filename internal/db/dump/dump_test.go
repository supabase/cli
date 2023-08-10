package dump

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     "localhost",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestPullCommand(t *testing.T) {
	imageUrl := utils.GetRegistryImageUrl(utils.Pg15Image)
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
		err := Run(context.Background(), "schema.sql", dbConfig, nil, false, false, false, false, false, fsys)
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
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), "", dbConfig, []string{"public"}, false, false, false, false, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
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
		err := Run(context.Background(), "", dbConfig, nil, false, false, false, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), "schema.sql", dbConfig, nil, false, false, false, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
