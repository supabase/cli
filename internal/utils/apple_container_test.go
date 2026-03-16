package utils

import (
	"context"
	"encoding/json"
	stderrors "errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/containerd/errdefs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHasAppleInspectRecords(t *testing.T) {
	t.Run("returns false for empty results", func(t *testing.T) {
		assert.False(t, hasAppleInspectRecords(""))
		assert.False(t, hasAppleInspectRecords("[]"))
	})

	t.Run("returns true for populated results", func(t *testing.T) {
		assert.True(t, hasAppleInspectRecords(`[{"id":"supabase-network-demo"}]`))
	})

	t.Run("returns false for invalid json", func(t *testing.T) {
		assert.False(t, hasAppleInspectRecords("not-json"))
	})
}

func TestAppleMountRecord(t *testing.T) {
	t.Run("parses object mount type", func(t *testing.T) {
		record := appleMountRecord{
			Destination: "/var/lib/postgresql/data",
			Type:        json.RawMessage(`{"volume":{"name":"supabase-db-demo"}}`),
		}

		assert.Equal(t, "/var/lib/postgresql/data", record.mountTarget())
		assert.Equal(t, "volume", record.mountType())
		assert.False(t, record.isReadOnly())
	})

	t.Run("parses string mount type and readonly option", func(t *testing.T) {
		record := appleMountRecord{
			Target:  "/data",
			Type:    json.RawMessage(`"bind"`),
			Options: []string{"readonly"},
		}

		assert.Equal(t, "/data", record.mountTarget())
		assert.Equal(t, "bind", record.mountType())
		assert.True(t, record.isReadOnly())
	})
}

func TestWaitForAppleReady(t *testing.T) {
	t.Run("retries until resource is ready", func(t *testing.T) {
		attempts := 0

		err := waitForAppleReady(context.Background(), "network", func() (bool, error) {
			attempts++
			return attempts == 3, nil
		})

		require.NoError(t, err)
		assert.Equal(t, 3, attempts)
	})

	t.Run("returns probe error", func(t *testing.T) {
		probeErr := stderrors.New("boom")
		attempts := 0

		err := waitForAppleReady(context.Background(), "network", func() (bool, error) {
			attempts++
			if attempts == 2 {
				return false, probeErr
			}
			return false, nil
		})

		require.ErrorIs(t, err, probeErr)
	})

	t.Run("returns timeout error", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()

		err := waitForAppleReady(ctx, "network", func() (bool, error) {
			return false, nil
		})

		require.Error(t, err)
		assert.Contains(t, err.Error(), "network was not ready in time")
	})
}

func TestAppleStopAndDeleteContainers(t *testing.T) {
	t.Run("falls back to force delete when stop times out", func(t *testing.T) {
		var calls [][]string
		run := func(_ context.Context, args ...string) (string, error) {
			calls = append(calls, append([]string(nil), args...))
			if len(args) > 0 && args[0] == "stop" {
				return "", stderrors.New(`internalError: "failed to stop container"`)
			}
			return "", nil
		}

		err := appleStopAndDeleteContainers(context.Background(), []string{"db"}, []string{"db", "rest"}, run)

		require.NoError(t, err)
		require.Len(t, calls, 2)
		assert.Equal(t, []string{"stop", "db"}, calls[0])
		assert.Equal(t, []string{"delete", "--force", "db", "rest"}, calls[1])
	})

	t.Run("returns both errors when stop and force delete fail", func(t *testing.T) {
		run := func(_ context.Context, args ...string) (string, error) {
			if len(args) > 0 && args[0] == "stop" {
				return "", stderrors.New("stop timeout")
			}
			return "", stderrors.New("delete failed")
		}

		err := appleStopAndDeleteContainers(context.Background(), []string{"db"}, []string{"db"}, run)

		require.Error(t, err)
		assert.True(t, strings.Contains(err.Error(), "failed to stop containers"))
		assert.True(t, strings.Contains(err.Error(), "failed to delete containers"))
	})
}

func TestAppleRestartContainerWithRun(t *testing.T) {
	t.Run("stops then starts container", func(t *testing.T) {
		var calls [][]string
		run := func(_ context.Context, args ...string) (string, error) {
			calls = append(calls, append([]string(nil), args...))
			return "", nil
		}

		err := appleRestartContainerWithRun(context.Background(), "db", run)

		require.NoError(t, err)
		assert.Equal(t, [][]string{{"stop", "db"}, {"start", "db"}}, calls)
	})

	t.Run("maps not found to errdefs", func(t *testing.T) {
		run := func(_ context.Context, args ...string) (string, error) {
			return "", stderrors.New("notFound: no such container")
		}

		err := appleRestartContainerWithRun(context.Background(), "db", run)

		require.ErrorIs(t, err, errdefs.ErrNotFound)
	})
}

func TestAppleRemoveVolumeWithRun(t *testing.T) {
	t.Run("deletes named volume", func(t *testing.T) {
		var calls [][]string
		run := func(_ context.Context, args ...string) (string, error) {
			calls = append(calls, append([]string(nil), args...))
			return "", nil
		}

		err := appleRemoveVolumeWithRun(context.Background(), "db-volume", true, run)

		require.NoError(t, err)
		assert.Equal(t, [][]string{{"volume", "delete", "db-volume"}}, calls)
	})

	t.Run("maps missing volume to errdefs", func(t *testing.T) {
		run := func(_ context.Context, args ...string) (string, error) {
			return "", stderrors.New("volume not found")
		}

		err := appleRemoveVolumeWithRun(context.Background(), "db-volume", true, run)

		require.ErrorIs(t, err, errdefs.ErrNotFound)
	})
}

func TestAppleRemoveContainer(t *testing.T) {
	t.Run("maps missing container to errdefs", func(t *testing.T) {
		originalExec := execContainerCommand
		t.Cleanup(func() {
			execContainerCommand = originalExec
		})

		execContainerCommand = func(context.Context, string, ...string) *exec.Cmd {
			return exec.Command("sh", "-c", "echo 'not found' 1>&2; exit 1")
		}

		err := appleRemoveContainer(context.Background(), "missing", true)

		require.ErrorIs(t, err, errdefs.ErrNotFound)
	})
}
