package init

import (
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func gitIgnorePath(t *testing.T) string {
	root, err := utils.GetGitRoot()
	assert.NoError(t, err)
	return filepath.Join(*root, ".gitignore")
}

func TestInitCommand(t *testing.T) {
	t.Run("creates config file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		// Run test
		assert.NoError(t, Run(fsys))
		// Validate generated config.toml
		exists, err := afero.Exists(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated .gitignore
		exists, err = afero.Exists(fsys, gitIgnorePath(t))
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("throws error when config file exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(fsys))
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(fsys))
	})

	t.Run("appends to git ignore", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		path := gitIgnorePath(t)
		_, err := fsys.Create(path)
		require.NoError(t, err)
		// Run test
		assert.NoError(t, Run(fsys))
		// Validate file contents
		content, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, initGitignore, content[1:])
	})

	// TODO: test all error edge cases around git ignore
}
