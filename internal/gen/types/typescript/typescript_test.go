package typescript

import (
	"bytes"
	"context"
	"net/http"
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

func TestGenLocalCommand(t *testing.T) {
	const version = "1.41"

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, afero.NewMemMapFs()))
	})

	t.Run("throws error when db is not started", func(t *testing.T) {
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
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error failure to exec", func(t *testing.T) {
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
			Reply(200).
			JSON(types.ContainerJSON{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGenRemoteCommand(t *testing.T) {
	const dbUrl = "postgres://postgres:@localhost:5432/postgres"
	const version = "1.41"
	const containerId = "test-container"

	t.Run("generates type from remote db", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images").
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
		_, err := writer.Write([]byte("hello world"))
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
		assert.NoError(t, Run(context.Background(), false, false, "", dbUrl, []string{}, afero.NewMemMapFs()))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed db url", func(t *testing.T) {
		// Run test
		assert.Error(t, Run(context.Background(), false, false, "", "foo", []string{}, afero.NewMemMapFs()))
	})

	t.Run("throws error when docker is not started", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), false, false, "", dbUrl, []string{}, afero.NewMemMapFs()))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
