package bootstrap

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSuggestAppStart(t *testing.T) {
	t.Run("suggest npm", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		suggestion := suggestAppStart(cwd)
		// Check error
		assert.Equal(t, "To start your app:\n  npm ci\n  npm run dev", suggestion)
	})

	t.Run("suggest cd", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		suggestion := suggestAppStart(filepath.Dir(cwd))
		// Check error
		expected := "To start your app:"
		expected += "\n  cd " + filepath.Base(cwd)
		expected += "\n  npm ci"
		expected += "\n  npm run dev"
		assert.Equal(t, expected, suggestion)
	})

	t.Run("ignore relative path", func(t *testing.T) {
		// Run test
		suggestion := suggestAppStart(".")
		// Check error
		assert.Equal(t, "To start your app:\n  npm ci\n  npm run dev", suggestion)
	})
}
