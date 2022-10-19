package init

import (
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestInitCommand(t *testing.T) {
	t.Run("creates config file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		require.NoError(t, fsys.Mkdir(".git", 0755))
		// Run test
		assert.NoError(t, Run(fsys))
		// Validate generated config.toml
		exists, err := afero.Exists(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated .gitignore
		ignorePath := filepath.Join(filepath.Dir(utils.ConfigPath), ".gitignore")
		exists, err = afero.Exists(fsys, ignorePath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated seed.sql
		exists, err = afero.Exists(fsys, utils.SeedDataPath)
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("does not generate gitignore if no git", func(t *testing.T) {
		// Setup read-only fs
		fsys := &afero.MemMapFs{}
		// Run test
		assert.NoError(t, Run(fsys))
		// Validate generated config.toml
		exists, err := afero.Exists(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated .gitignore
		ignorePath := filepath.Join(filepath.Dir(utils.ConfigPath), ".gitignore")
		exists, err = afero.Exists(fsys, ignorePath)
		assert.NoError(t, err)
		assert.False(t, exists)
		// Validate generated seed.sql
		exists, err = afero.Exists(fsys, utils.SeedDataPath)
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

	t.Run("throws error on failure to write config", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(fsys))
	})
}

func TestUpdateGitIgnore(t *testing.T) {
	const ignorePath = "/home/supabase/.gitignore"

	t.Run("appends to git ignore", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create(ignorePath)
		require.NoError(t, err)
		// Run test
		assert.NoError(t, updateGitIgnore(ignorePath, fsys))
		// Validate file contents
		content, err := afero.ReadFile(fsys, ignorePath)
		assert.NoError(t, err)
		assert.Equal(t, append([]byte("\n"), initGitignore...), content)
	})

	t.Run("noop if already ignored", func(t *testing.T) {
		// Setup read-only fs
		fsys := &afero.MemMapFs{}
		require.NoError(t, afero.WriteFile(fsys, ignorePath, initGitignore, 0644))
		// Run test
		assert.NoError(t, updateGitIgnore(ignorePath, fsys))
		// Validate file contents
		content, err := afero.ReadFile(fsys, ignorePath)
		assert.NoError(t, err)
		assert.Equal(t, initGitignore, content)
	})

	t.Run("throws error on failure to create", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, updateGitIgnore(ignorePath, fsys))
	})
}
