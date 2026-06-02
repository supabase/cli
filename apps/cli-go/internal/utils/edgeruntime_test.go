package utils

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
