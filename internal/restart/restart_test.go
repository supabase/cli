package restart

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestRestartCommand(t *testing.T) {
	t.Run("restart containers", func(t *testing.T) {
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

		// Run test
		err := Run(context.Background(), "", false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("restart all instances when --all flag is used", func(t *testing.T) {
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

		// Mock restartOneProject for each project
		for _, projectId := range projects {
			// Mock ContainerList for each project
			gock.New(utils.Docker.DaemonHost()).
				Get("/v"+utils.Docker.ClientVersion()+"/containers/json").
				MatchParam("all", "1").
				MatchParam("filters", fmt.Sprintf(`{"label":{"com.supabase.cli.project=%s":true}}`, projectId)).
				Reply(http.StatusOK).
				JSON([]container.Summary{{ID: "container-" + projectId, State: "running"}})

			// Mock container restart
			gock.New(utils.Docker.DaemonHost()).
				Post("/v" + utils.Docker.ClientVersion() + "/containers/container-" + projectId + "/restart").
				Reply(http.StatusOK)
		}

		// Mock final ContainerList to verify all containers are restarted
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
		err := Run(context.Background(), "", true, fsys)

		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), "", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on restart failure", func(t *testing.T) {
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
		err := Run(context.Background(), "test", false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "request returned 503 Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRestartServices(t *testing.T) {
	t.Run("restart all services", func(t *testing.T) {
		containers := []container.Summary{{ID: "c1", State: "running"}, {ID: "c2"}}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON(containers)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + containers[0].ID + "/restart").
			Reply(http.StatusOK)
		// Run test
		err := restart(context.Background(), io.Discard, utils.Config.ProjectId)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
