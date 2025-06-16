package serve

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

type stepClock struct {
	mu   sync.Mutex
	now  time.Time
	step time.Duration
}

func (c *stepClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(c.step)
	return c.now
}

func NewStepClock(step time.Duration) backoff.Clock {
	return &stepClock{
		now:  time.Now(),
		step: step,
	}
}

func TestLogStreamer(t *testing.T) {
	containerID := "test-container"

	t.Run("streams logs from container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("failed"))
		// Run test
		streamer := NewLogStreamer(context.Background(), func(ls *logStreamer) {
			ls.clock = NewStepClock(time.Second)
		})
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
		apitest.MockDockerLogsStream(utils.Docker, containerID, 0, strings.NewReader("stopped"))
		apitest.MockDockerLogsStream(utils.Docker, containerID, 137, strings.NewReader("killed"))
		apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("failed"))
		// Run test
		streamer := NewLogStreamer(context.Background(), func(ls *logStreamer) {
			ls.clock = NewStepClock(time.Second)
		})
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
		apitest.MockDockerLogsStream(utils.Docker, containerID, 1, strings.NewReader("failed"))
		// Run test
		streamer := NewLogStreamer(context.Background(), func(ls *logStreamer) {
			ls.clock = NewStepClock(time.Second)
		})
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
