package utils

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRunAppleAnalyticsLogForwarder(t *testing.T) {
	originalExec := execContainerCommand
	t.Cleanup(func() {
		execContainerCommand = originalExec
	})
	execContainerCommand = func(_ context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command("sh", "-c", "printf 'hello\\n'; printf 'warn\\n' 1>&2")
	}

	outputPath := filepath.Join(t.TempDir(), "forwarder.jsonl")
	err := RunAppleAnalyticsLogForwarder(context.Background(), "supabase-rest-demo", outputPath)

	require.NoError(t, err)
	data, err := os.ReadFile(outputPath)
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	require.Len(t, lines, 2)
	joined := strings.Join(lines, "\n")
	assert.Contains(t, joined, `"container_name":"supabase-rest-demo"`)
	assert.Contains(t, joined, `"stream":"stdout"`)
	assert.Contains(t, joined, `"message":"hello"`)
	assert.Contains(t, joined, `"stream":"stderr"`)
	assert.Contains(t, joined, `"message":"warn"`)
}

func TestAppleAnalyticsForwarderLifecycle(t *testing.T) {
	originalStateDir := resolveAppleAnalyticsStateDir
	originalStarter := startAppleAnalyticsForwarderProcess
	originalInterrupt := interruptAppleAnalyticsForwarderProcess
	tempDir := t.TempDir()
	var started []string
	var stopped []int
	t.Cleanup(func() {
		resolveAppleAnalyticsStateDir = originalStateDir
		startAppleAnalyticsForwarderProcess = originalStarter
		interruptAppleAnalyticsForwarderProcess = originalInterrupt
	})
	resolveAppleAnalyticsStateDir = func() (string, error) {
		return tempDir, nil
	}
	startAppleAnalyticsForwarderProcess = func(containerID, outputPath string) (int, error) {
		started = append(started, containerID+"="+outputPath)
		return len(started) + 100, nil
	}
	interruptAppleAnalyticsForwarderProcess = func(pid int) error {
		stopped = append(stopped, pid)
		return nil
	}

	err := StartAppleAnalyticsForwarders([]string{"db", "rest"})
	require.NoError(t, err)
	assert.Len(t, started, 2)
	assert.FileExists(t, filepath.Join(tempDir, appleAnalyticsPidsDirName, "db.pid"))
	assert.FileExists(t, filepath.Join(tempDir, appleAnalyticsPidsDirName, "rest.pid"))

	err = StopAppleAnalyticsForwarders(afero.NewOsFs())
	require.NoError(t, err)
	assert.Equal(t, []int{101, 102}, stopped)
	_, err = os.Stat(tempDir)
	assert.ErrorIs(t, err, os.ErrNotExist)
}
