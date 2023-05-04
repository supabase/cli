package credentials

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPromptMasked(t *testing.T) {
	t.Run("reads from piped stdin", func(t *testing.T) {
		// Setup token
		r, w, err := os.Pipe()
		require.NoError(t, err)
		_, err = w.WriteString("token")
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Run test
		input := PromptMasked(r)
		// Check error
		assert.Equal(t, "token", input)
	})

	t.Run("empty string on closed pipe", func(t *testing.T) {
		// Setup empty stdin
		r, _, err := os.Pipe()
		require.NoError(t, err)
		require.NoError(t, r.Close())
		// Run test
		input := PromptMasked(r)
		// Check error
		assert.Empty(t, input)
	})
}
