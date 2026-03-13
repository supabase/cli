package fstest

import (
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func MockStdout(t *testing.T, output string) func() {
	r, w, err := os.Pipe()
	require.NoError(t, err)
	// Replace stdout
	oldStdout := os.Stdout
	teardown := func() {
		os.Stdout = oldStdout
		assert.NoError(t, w.Close())
		data, err := io.ReadAll(r)
		assert.NoError(t, err)
		assert.Equal(t, output, string(data))
	}
	os.Stdout = w
	return teardown
}
