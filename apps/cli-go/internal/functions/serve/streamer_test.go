package serve

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestLogStreamer(t *testing.T) {
	containerID := "test-container"
	retryInterval = 0

	t.Run("streams logs from container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("")))
		// Run test
		streamer := NewLogStreamer(context.Background())
		streamer.Start(containerID)
		// Check error
		select {
		case err := <-streamer.ErrCh:
			assert.ErrorContains(t, err, "error running container: exit 1")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing error signal from closing")
		}
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("retries on container exit", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerID, 0, strings.NewReader("")))
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerID, 137, strings.NewReader("")))
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("")))
		// Run test
		streamer := NewLogStreamer(context.Background())
		streamer.Start(containerID)
		// Check error
		select {
		case err := <-streamer.ErrCh:
			assert.ErrorContains(t, err, "error running container: exit 1")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing error signal from closing")
		}
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("retries on missing container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + containerID + "/logs").
			Reply(http.StatusNotFound).
			BodyString("No such container")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + containerID + "/logs").
			Reply(http.StatusConflict).
			BodyString("can not get logs from container which is dead or marked for removal")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + containerID + "/logs").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + containerID + "/json").
			Reply(http.StatusNotFound).
			BodyString("No such object")
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("")))
		// Run test
		streamer := NewLogStreamer(context.Background())
		streamer.Start(containerID)
		// Check error
		select {
		case err := <-streamer.ErrCh:
			assert.ErrorContains(t, err, "error running container: exit 1")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing error signal from closing")
		}
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
