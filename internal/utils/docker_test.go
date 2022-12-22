package utils

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
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
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusNotFound)
		gock.New(Docker.DaemonHost()).
			Post("/v"+Docker.ClientVersion()+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted)
		// Run test
		assert.NoError(t, DockerPullImageIfNotCached(context.Background(), imageId))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("does nothing if image exists", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		assert.NoError(t, DockerPullImageIfNotCached(context.Background(), imageId))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error if docker is unavailable", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, DockerPullImageIfNotCached(context.Background(), imageId))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to pull image", func(t *testing.T) {
		timeUnit = time.Duration(0)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusNotFound)
		// Total 3 tries
		gock.New(Docker.DaemonHost()).
			Post("/v"+Docker.ClientVersion()+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusServiceUnavailable)
		gock.New(Docker.DaemonHost()).
			Post("/v"+Docker.ClientVersion()+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted).
			JSON(jsonmessage.JSONMessage{Error: &jsonmessage.JSONError{Message: "toomanyrequests"}})
		gock.New(Docker.DaemonHost()).
			Post("/v"+Docker.ClientVersion()+"/images/create").
			MatchParam("fromImage", imageId).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted).
			JSON(jsonmessage.JSONMessage{Error: &jsonmessage.JSONError{Message: "no space left on device"}})
		// Run test
		err := DockerPullImageIfNotCached(context.Background(), imageId)
		// Validate api
		assert.ErrorContains(t, err, "no space left on device")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRunOnce(t *testing.T) {
	viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")

	t.Run("runs once in container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageId, containerId)
		require.NoError(t, apitest.MockDockerLogs(Docker, containerId, "hello world"))
		// Run test
		out, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.NoError(t, err)
		// Validate api
		assert.Equal(t, "hello world", out)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on container create", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(types.NetworkCreateResponse{})
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/containers/create").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on container start", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Get("/v" + Docker.ClientVersion() + "/images/" + imageId + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(types.NetworkCreateResponse{})
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/containers/create").
			Reply(http.StatusOK).
			JSON(container.ContainerCreateCreatedBody{ID: containerId})
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/containers/" + containerId + "/start").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("removes container on cancel", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageId, containerId)
		gock.New(Docker.DaemonHost()).
			Get("/v"+Docker.ClientVersion()+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			Delay(1 * time.Second)
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(200*time.Millisecond))
		defer cancel()
		gock.New(Docker.DaemonHost()).
			Delete("/v" + Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		// Run test
		_, err := DockerRunOnce(ctx, imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to parse logs", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageId, containerId)
		gock.New(Docker.DaemonHost()).
			Get("/v"+Docker.ClientVersion()+"/containers/"+containerId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			BodyString("hello world")
		gock.New(Docker.DaemonHost()).
			Delete("/v" + Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		// Run test
		_, err := DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to inspect", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageId, containerId)
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
		gock.New(Docker.DaemonHost()).
			Delete("/v" + Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		// Run test
		_, err = DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on non-zero exit code", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageId, containerId)
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
		gock.New(Docker.DaemonHost()).
			Delete("/v" + Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		// Run test
		_, err = DockerRunOnce(context.Background(), imageId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestExecOnce(t *testing.T) {
	t.Run("throws error on failure to exec", func(t *testing.T) {
		// Setup mock server
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/containers/" + containerId + "/exec").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := DockerExecOnce(context.Background(), containerId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to hijack", func(t *testing.T) {
		// Setup mock server
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		gock.New(Docker.DaemonHost()).
			Post("/v" + Docker.ClientVersion() + "/containers/" + containerId + "/exec").
			Reply(http.StatusAccepted).
			JSON(types.IDResponse{ID: "test-command"})
		// Run test
		_, err := DockerExecOnce(context.Background(), containerId, nil, nil)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	// TODO: mock tcp hijack
}
