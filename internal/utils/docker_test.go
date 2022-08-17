package utils

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/h2non/gock.v1"
)

const (
	version     = "1.41"
	containerId = "test-container"
	imageId     = "test-image"
)

func TestPullImage(t *testing.T) {
	viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")

	t.Run("pulls image if missing", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
			Reply(http.StatusNotFound)
		gock.New("http:///var/run/docker.sock").
			Post("/v"+version+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted)
		// Run test
		assert.NoError(t, DockerPullImageIfNotCached(context.Background(), imageId))
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("does nothing if image exists", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		assert.NoError(t, DockerPullImageIfNotCached(context.Background(), imageId))
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error if docker is unavailable", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, DockerPullImageIfNotCached(context.Background(), imageId))
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on failure to pull image", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
			Reply(http.StatusNotFound)
		gock.New("http:///var/run/docker.sock").
			Post("/v"+version+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, DockerPullImageIfNotCached(context.Background(), imageId))
		assert.False(t, gock.HasUnmatchedRequest())
	})
}

func TestRunOnce(t *testing.T) {
	viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")

	t.Run("runs once in container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
		out, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.NoError(t, err)
		// Validate output
		assert.Equal(t, "hello world", out)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on container create", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/networks").
			Reply(http.StatusOK).
			JSON(types.NetworkResource{})
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/create").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on container start", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("stops container on cancel", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
		gock.New("http:///var/run/docker.sock").
			Get("/v"+version+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			Delay(1 * time.Second)
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + containerId + "/stop").
			Reply(http.StatusServiceUnavailable)
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(200*time.Millisecond))
		defer cancel()
		// Run test
		_, err := DockerRunOnce(ctx, imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on failure to parse logs", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
		gock.New("http:///var/run/docker.sock").
			Get("/v"+version+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			BodyString("hello world")
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on failure to inspect", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err = DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on non-zero exit code", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Get("/v" + version + "/images/docker.io/" + imageId + "/json").
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
			JSON(types.ContainerJSONBase{State: &types.ContainerState{ExitCode: 1}})
		// Run test
		_, err = DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})
}

func TestExecOnce(t *testing.T) {
	t.Run("throws error on failure to exec", func(t *testing.T) {
		// Setup mock server
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + containerId + "/exec").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerExecOnce(context.Background(), containerId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("throws error on failure to hijack", func(t *testing.T) {
		// Setup mock server
		require.NoError(t, client.WithHTTPClient(http.DefaultClient)(Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		gock.New("http:///var/run/docker.sock").
			Post("/v" + version + "/containers/" + containerId + "/exec").
			Reply(http.StatusAccepted).
			JSON(types.IDResponse{ID: "test-command"})
		// Run test
		_, err := DockerExecOnce(context.Background(), containerId, nil, nil)
		assert.Error(t, err)
		assert.False(t, gock.HasUnmatchedRequest())
	})

	// TODO: mock tcp hijack
}
