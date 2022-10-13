package utils

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProjectRoot(t *testing.T) {
	t.Run("searches project root recursively", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(filepath.Join("/", ConfigPath))
		require.NoError(t, err)
		// Run test
		path, err := GetProjectRoot(fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "/", path)
	})

	t.Run("stops at root dir", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		path, err := GetProjectRoot(fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, cwd, path)
	})
}
