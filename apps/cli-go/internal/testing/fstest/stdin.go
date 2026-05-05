package fstest

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func MockStdin(t *testing.T, input string) func() {
	// Setup stdin
	r, w, err := os.Pipe()
	require.NoError(t, err)
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
