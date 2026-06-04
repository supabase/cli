package utils

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
