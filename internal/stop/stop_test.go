package stop

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
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
		err := Run(context.Background(), false, fsys)
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
		err := Run(context.Background(), false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on backup failure", func(t *testing.T) {
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
			Get("/v" + version + "/images").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), true, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "network error")
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
		err := Run(context.Background(), false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("ignores permission error", func(t *testing.T) {
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
		err := Run(context.Background(), false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.NoError(t, err)
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

func TestBackupDatabase(t *testing.T) {
	const version = "1.41"
	const containerId = "test-db"

	t.Run("backup main branch", func(t *testing.T) {
		image := utils.GetRegistryImageUrl(utils.Pg14Image)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/" + image + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/networks").
			Reply(http.StatusOK).
			JSON(types.NetworkResource{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/create").
			Reply(http.StatusOK).
			JSON(container.ContainerCreateCreatedBody{ID: containerId})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + containerId + "/start").
			Reply(http.StatusAccepted)
		// Setup docker style logs
		var body bytes.Buffer
		writer := stdcopy.NewStdWriter(&body, stdcopy.Stdout)
		dumped := []byte("create schema public")
		_, err := writer.Write(dumped)
		require.NoError(t, err)
		gock.New("http:///var/run/docker.sock").
			Get("/v"+version+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			Body(&body)
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + containerId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSONBase{State: &types.ContainerState{ExitCode: 0}})
		// Run test
		err = backupDatabase(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		path := filepath.Join(filepath.Dir(utils.CurrBranchPath), "main", "dump.sql")
		// Check branch dumped
		contents, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, dumped, contents)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		image := utils.GetRegistryImageUrl(utils.Pg14Image)
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/" + image + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/networks").
			Reply(http.StatusOK).
			JSON(types.NetworkResource{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/create").
			Reply(http.StatusOK).
			JSON(container.ContainerCreateCreatedBody{ID: containerId})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + containerId + "/start").
			Reply(http.StatusAccepted)
		// Setup docker style logs
		var body bytes.Buffer
		writer := stdcopy.NewStdWriter(&body, stdcopy.Stdout)
		dumped := []byte("create schema public")
		_, err := writer.Write(dumped)
		require.NoError(t, err)
		gock.New("http:///var/run/docker.sock").
			Get("/v"+version+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			Body(&body)
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/containers/" + containerId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSONBase{State: &types.ContainerState{ExitCode: 0}})
		// Run test
		err = backupDatabase(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
