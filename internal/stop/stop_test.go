package stop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
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
			JSON([]container.Summary{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			Reply(http.StatusOK).
			JSON(container.PruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
			Reply(http.StatusOK).
			JSON(network.PruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes").
			Reply(http.StatusOK).
			JSON(volume.ListResponse{Volumes: []*volume.Volume{{
				Name: utils.DbId,
			}}})
		// Run test
		err := Run(context.Background(), true, "", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("stops all instances when --all flag is used", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		projects := []string{"project1", "project2"}

		// Mock initial ContainerList for all containers
		gock.New(utils.Docker.DaemonHost()).
			Get("/v"+utils.Docker.ClientVersion()+"/containers/json").
			MatchParam("all", "true").
			Reply(http.StatusOK).
			JSON([]container.Summary{
				{ID: "container1", Labels: map[string]string{utils.CliProjectLabel: "project1"}},
				{ID: "container2", Labels: map[string]string{utils.CliProjectLabel: "project2"}},
			})

		// Mock initial VolumeList
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes").
			Reply(http.StatusOK).
			JSON(volume.ListResponse{
				Volumes: []*volume.Volume{
					{Name: "volume1", Labels: map[string]string{utils.CliProjectLabel: "project1"}},
					{Name: "volume2", Labels: map[string]string{utils.CliProjectLabel: "project2"}},
				},
			})

		// Mock stopOneProject for each project
		for _, projectId := range projects {
			// Mock ContainerList for each project
			gock.New(utils.Docker.DaemonHost()).
				Get("/v"+utils.Docker.ClientVersion()+"/containers/json").
				MatchParam("all", "1").
				MatchParam("filters", fmt.Sprintf(`{"label":{"com.supabase.cli.project=%s":true}}`, projectId)).
				Reply(http.StatusOK).
				JSON([]container.Summary{{ID: "container-" + projectId, State: "running"}})

			// Mock container stop
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/container-" + projectId + "/stop").
				Reply(http.StatusOK)

			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
				Reply(http.StatusOK).
				JSON(container.PruneReport{})
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
				Reply(http.StatusOK).
				JSON(network.PruneReport{})
			gock.New(utils.Docker.DaemonHost()).
				Get("/v"+utils.Docker.ClientVersion()+"/volumes").
				MatchParam("filters", fmt.Sprintf(`{"label":{"com.supabase.cli.project=%s":true}}`, projectId)).
				Reply(http.StatusOK).
				JSON(volume.ListResponse{Volumes: []*volume.Volume{{Name: "volume-" + projectId}}})
		}

		// Mock final ContainerList to verify all containers are stopped
		gock.New(utils.Docker.DaemonHost()).
			Get("/v"+utils.Docker.ClientVersion()+"/containers/json").
			MatchParam("all", "true").
			Reply(http.StatusOK).
			JSON([]container.Summary{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON([]container.Summary{})

		// Run test
		err := Run(context.Background(), true, "", true, fsys)

		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), false, "", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
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
		err := Run(context.Background(), false, "test", false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "request returned 503 Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestStopServices(t *testing.T) {
	t.Run("stops all services", func(t *testing.T) {
		containers := []container.Summary{{ID: "c1", State: "running"}, {ID: "c2"}}
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
			JSON(container.PruneReport{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/prune").
			Reply(http.StatusOK).
			JSON(network.PruneReport{})
		// Run test
		err := stop(context.Background(), true, io.Discard, utils.Config.ProjectId)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes data volumes", func(t *testing.T) {
		utils.DbId = "test-db"
		utils.ConfigId = "test-config"
		utils.StorageId = "test-storage"
		utils.EdgeRuntimeId = "test-functions"
		utils.InbucketId = "test-inbucket"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStop(utils.Docker)
		// Run test
		err := stop(context.Background(), false, io.Discard, utils.Config.ProjectId)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips all filter when removing data volumes with Docker version pre-v1.42", func(t *testing.T) {
		utils.DbId = "test-db"
		utils.ConfigId = "test-config"
		utils.StorageId = "test-storage"
		utils.EdgeRuntimeId = "test-functions"
		utils.InbucketId = "test-inbucket"
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		require.NoError(t, client.WithVersion("1.41")(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStop(utils.Docker)
		// Run test
		err := stop(context.Background(), false, io.Discard, utils.Config.ProjectId)
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
			JSON([]container.Summary{})
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/prune").
			ReplyError(errors.New("network error"))
		// Run test
		err := stop(context.Background(), true, io.Discard, utils.Config.ProjectId)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
