package utils

import (
	"bytes"
	"context"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
)

// DockerRunOnceWaitWithConfig must detect container completion via inspect and
// read logs without following the stream. Following the log stream to detect
// exit hangs forever under podman, whose /logs?follow endpoint never closes when
// the container stops (supabase/pg-toolbelt#312). These tests pin that the runner
// reads the captured output and maps the inspected exit code to an error.
func TestDockerRunOnceWait(t *testing.T) {
	imageUrl := GetRegistryImageUrl(imageId)

	t.Run("waits for exit then reads buffered logs", func(t *testing.T) {
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(Docker, containerId, "CATALOG\n"))
		// Run test
		var stdout, stderr bytes.Buffer
		err := DockerRunOnceWaitWithConfig(
			context.Background(),
			container.Config{Image: imageUrl},
			container.HostConfig{},
			network.NetworkingConfig{},
			containerId,
			&stdout,
			&stderr,
		)
		// Validate
		assert.NoError(t, err)
		assert.Equal(t, "CATALOG\n", stdout.String())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("maps non-zero exit code to error", func(t *testing.T) {
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogsExitCode(Docker, containerId, 1))
		// Run test
		var stdout, stderr bytes.Buffer
		err := DockerRunOnceWaitWithConfig(
			context.Background(),
			container.Config{Image: imageUrl},
			container.HostConfig{},
			network.NetworkingConfig{},
			containerId,
			&stdout,
			&stderr,
		)
		// Validate
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
