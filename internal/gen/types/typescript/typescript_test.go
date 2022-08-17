package typescript

import (
	"bytes"
	"fmt"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func ListUnmatchedRequests() []string {
	result := make([]string, len(gock.GetUnmatchedRequests()))
	for i, r := range gock.GetUnmatchedRequests() {
		result[i] = fmt.Sprintln(r.Method, r.URL.Path)
	}
	return result
}

func TestGenLocalCommand(t *testing.T) {
	const version = "1.41"

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(true, "", afero.NewMemMapFs()))
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
		assert.Error(t, Run(true, "", fsys))
		// Validate output
		assert.False(t, gock.HasUnmatchedRequest(), ListUnmatchedRequests())
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
		assert.Error(t, Run(true, "", fsys))
		// Validate output
		assert.False(t, gock.HasUnmatchedRequest(), ListUnmatchedRequests())
	})
}

func TestGenRemoteCommand(t *testing.T) {
	const dbUrl = "postgres://postgres:@localhost:5432/postgres"
	const version = "1.41"
	const containerId = "test-container"

	t.Run("generates type from remote db", func(t *testing.T) {
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
		assert.NoError(t, Run(false, dbUrl, fsys))
		// Validate output
		assert.False(t, gock.HasUnmatchedRequest(), ListUnmatchedRequests())
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(false, "", afero.NewMemMapFs()))
	})

	t.Run("throws error on malformed db url", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		assert.Error(t, Run(false, "", fsys))
	})

	t.Run("throws error when docker is not started", func(t *testing.T) {
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
			Get("/v" + version + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(false, dbUrl, fsys))
		// Validate output
		assert.False(t, gock.HasUnmatchedRequest(), ListUnmatchedRequests())
	})
}
