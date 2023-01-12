package stop

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestStopCommand(t *testing.T) {
	t.Run("stops containers with backup", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON([]types.Container{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			Reply(http.StatusOK).
			JSON(types.ContainersPruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := Run(context.Background(), true, fsys)
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
		err := Run(context.Background(), false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Missing config: open supabase/config.toml: file does not exist")
	})

	t.Run("throws error on stop failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestStopServices(t *testing.T) {
	t.Run("stops all services", func(t *testing.T) {
		containers := []types.Container{{ID: "c1", State: "running"}, {ID: "c2"}}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON(containers)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + containers[0].ID + "/stop").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			Reply(http.StatusOK).
			JSON(types.ContainersPruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := stop(context.Background(), true)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes data volumes", func(t *testing.T) {
		utils.DbId = "test-db"
		utils.StorageId = "test-storage"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON([]types.Container{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			Reply(http.StatusOK).
			JSON(types.ContainersPruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.StorageId).
			Reply(http.StatusNotFound)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
			Reply(http.StatusOK).
			JSON(types.NetworksPruneReport{})
		// Run test
		err := stop(context.Background(), false)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on prune failure", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON([]types.Container{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			ReplyError(errors.New("network error"))
		// Run test
		err := stop(context.Background(), true)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
