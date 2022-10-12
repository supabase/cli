package stop

import (
	"context"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestStopCommand(t *testing.T) {
	const version = "1.41"

	t.Run("stops containers", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		require.NoError(t, afero.WriteFile(fsys, utils.CurrBranchPath, []byte("main"), 0644))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/json").
			Reply(http.StatusOK).
			JSON([]types.Container{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Check branches removed
		exists, err := afero.Exists(fsys, utils.CurrBranchPath)
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "Missing config: open supabase/config.toml: file does not exist")
	})

	t.Run("ignores stopped database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on stop failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/json").
			Reply(http.StatusOK).
			JSON([]types.Container{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := Run(context.Background(), afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestStopServices(t *testing.T) {
	const version = "1.41"

	t.Run("stops all services", func(t *testing.T) {
		containers := []types.Container{{ID: "c1"}, {ID: "c2"}}
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/json").
			Reply(http.StatusOK).
			JSON(containers)
		for _, c := range containers {
			gock.New("http:///var/run/docker.sock").
				Delete("/v" + version + "/containers/" + c.ID).
				Reply(http.StatusOK)
		}
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := stop(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on list failure", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := stop(context.Background())
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
