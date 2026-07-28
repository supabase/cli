package utils

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/h2non/gock"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
)

// mockEdgeRuntimeLogs registers the docker responses RunEdgeRuntimeScript needs:
// a one-shot log read multiplexing stdout+stderr, an inspect reporting the exit
// code, and the container delete. Mirrors apitest.MockDockerErrorLogs but also
// carries stdout so we can assert the success path preserves the script output.
func mockEdgeRuntimeLogs(t *testing.T, containerID, stdout, stderr string, exitCode int) {
	t.Helper()
	var body bytes.Buffer
	if len(stdout) > 0 {
		_, err := io.Copy(stdcopy.NewStdWriter(&body, stdcopy.Stdout), strings.NewReader(stdout))
		require.NoError(t, err)
	}
	if len(stderr) > 0 {
		_, err := io.Copy(stdcopy.NewStdWriter(&body, stdcopy.Stderr), strings.NewReader(stderr))
		require.NoError(t, err)
	}
	gock.New(Docker.DaemonHost()).
		Get("/v"+Docker.ClientVersion()+"/containers/"+containerID+"/logs").
		Reply(http.StatusOK).
		SetHeader("Content-Type", "application/vnd.docker.raw-stream").
		Body(&body)
	gock.New(Docker.DaemonHost()).
		Get("/v" + Docker.ClientVersion() + "/containers/" + containerID + "/json").
		Reply(http.StatusOK).
		JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
			State: &container.State{ExitCode: exitCode},
		}})
	gock.New(Docker.DaemonHost()).
		Delete("/v" + Docker.ClientVersion() + "/containers/" + containerID).
		Reply(http.StatusOK)
}

func TestRunEdgeRuntimeScript(t *testing.T) {
	const containerID = "test-edge-runtime"
	imageUrl := GetRegistryImageUrl(Config.EdgeRuntime.Image)

	t.Run("surfaces the real error when the script crashes behind the worker-destroyed message", func(t *testing.T) {
		viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")
		t.Cleanup(func() { viper.Set("INTERNAL_IMAGE_REGISTRY", "") })
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageUrl, containerID)
		// The pg-delta template throws to force the worker to exit (surfacing as a
		// non-zero exit + "main worker has been destroyed"), and its catch block
		// prints the real error and the sentinel. This must NOT look like an empty diff.
		stderr := "error: permission denied for table pg_user_mapping\n" +
			EdgeRuntimeScriptErrorSentinel + "\n" +
			"worker boot error\nmain worker has been destroyed\n"
		mockEdgeRuntimeLogs(t, containerID, "", stderr, 1)

		var stdout, stderrBuf bytes.Buffer
		err := RunEdgeRuntimeScript(context.Background(), nil, "console.log('x')", nil, "error diffing schema", &stdout, &stderrBuf)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "error diffing schema: error running script:")
		// The real, actionable error must reach the user, not "No schema changes found".
		assert.Contains(t, err.Error(), "permission denied for table pg_user_mapping")
	})

	t.Run("still ignores a worker-destroyed exit when no sentinel is present", func(t *testing.T) {
		viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")
		t.Cleanup(func() { viper.Set("INTERNAL_IMAGE_REGISTRY", "") })
		require.NoError(t, apitest.MockDocker(Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(Docker, imageUrl, containerID)
		// Success path: the template forces the worker to exit after writing output,
		// so the exit is non-zero with "main worker has been destroyed" but no sentinel.
		mockEdgeRuntimeLogs(t, containerID, "ALTER TABLE x;\n", "main worker has been destroyed\n", 1)

		var stdout, stderrBuf bytes.Buffer
		err := RunEdgeRuntimeScript(context.Background(), nil, "console.log('x')", nil, "error diffing schema", &stdout, &stderrBuf)
		require.NoError(t, err)
		assert.Equal(t, "ALTER TABLE x;\n", stdout.String())
	})
}

func TestBuildEdgeRuntimeEntrypoint(t *testing.T) {
	t.Run("emits a single heredoc when only the script is provided", func(t *testing.T) {
		got := buildEdgeRuntimeEntrypoint(
			[]edgeRuntimeFile{{name: "index.ts", content: "console.log('hi')"}},
			"edge-runtime start --main-service=.",
		)
		assert.True(t, strings.HasPrefix(got, "cat <<'__EDGE_RT_FILE_0__' > index.ts && edge-runtime start --main-service=.\n"))
		assert.Contains(t, got, "console.log('hi')\n__EDGE_RT_FILE_0__\n")
	})

	t.Run("chains heredocs in declaration order so each cat reads the matching body", func(t *testing.T) {
		got := buildEdgeRuntimeEntrypoint(
			[]edgeRuntimeFile{
				{name: "index.ts", content: "TS_CONTENT"},
				{name: ".npmrc", content: "NPMRC_CONTENT"},
			},
			"edge-runtime start --main-service=.",
		)
		// Both cat declarations must come before any body, separated by &&.
		assert.Contains(t, got, "cat <<'__EDGE_RT_FILE_0__' > index.ts && cat <<'__EDGE_RT_FILE_1__' > .npmrc && edge-runtime start --main-service=.")
		// Bodies must follow in the same order as the declarations.
		idxScript := strings.Index(got, "TS_CONTENT")
		idxNpmrc := strings.Index(got, "NPMRC_CONTENT")
		require.Greater(t, idxScript, 0)
		require.Greater(t, idxNpmrc, idxScript, ".npmrc body must come after index.ts body")
		// Sentinels close each body so user content containing `EOF` cannot
		// terminate the heredoc early.
		assert.Contains(t, got, "TS_CONTENT\n__EDGE_RT_FILE_0__")
		assert.Contains(t, got, "NPMRC_CONTENT\n__EDGE_RT_FILE_1__")
		assert.True(t, strings.HasSuffix(got, "\n"))
	})

	t.Run("returns just the command when no files are provided", func(t *testing.T) {
		got := buildEdgeRuntimeEntrypoint(nil, "edge-runtime start --main-service=.")
		assert.Equal(t, "edge-runtime start --main-service=.\n", got)
	})
}

func TestEdgeRuntimeStartCmd(t *testing.T) {
	t.Run("binds an explicit free port", func(t *testing.T) {
		cmd := EdgeRuntimeStartCmd()
		// Base command must always be present.
		assert.Equal(t, []string{"edge-runtime", "start", "--main-service=."}, cmd[:3])
		// A --port flag avoids collisions on the edge-runtime default port (#5407).
		var portFlag string
		for _, arg := range cmd {
			if strings.HasPrefix(arg, "--port=") {
				portFlag = arg
			}
		}
		require.NotEmpty(t, portFlag, "expected a --port flag to be set")
		port, err := strconv.Atoi(strings.TrimPrefix(portFlag, "--port="))
		require.NoError(t, err)
		assert.Greater(t, port, 0)
		assert.LessOrEqual(t, port, 65535)
	})

	t.Run("allocates a distinct port per invocation", func(t *testing.T) {
		first := getPortArg(t, EdgeRuntimeStartCmd())
		second := getPortArg(t, EdgeRuntimeStartCmd())
		assert.NotEqual(t, first, second)
	})
}

func getPortArg(t *testing.T, cmd []string) string {
	t.Helper()
	for _, arg := range cmd {
		if strings.HasPrefix(arg, "--port=") {
			return arg
		}
	}
	require.FailNow(t, "missing --port flag")
	return ""
}
