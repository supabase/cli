package utils

import (
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
