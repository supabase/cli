package fstest

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func MockStdin(t *testing.T, input string) func() {
	// Setup stdin
	r, w, err := os.Pipe()
	require.NoError(t, err)
	if len(input) > 0 && !strings.HasSuffix(input, "\n") {
		input += "\n"
	}
	_, err = w.WriteString(input)
	require.NoError(t, err)
	require.NoError(t, w.Close())
	// Replace stdin
	oldStdin := os.Stdin
	teardown := func() {
		os.Stdin = oldStdin
	}
	os.Stdin = r
	return teardown
}
