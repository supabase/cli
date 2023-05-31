package init

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
)

func TestInitCommand(t *testing.T) {
	t.Run("creates config file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		cwd, err := os.Getwd()
		require.NoError(t, err)
		require.NoError(t, fsys.Mkdir(".git", 0755))
		// Run test
		assert.NoError(t, Run(fsys, nil))
		// Validate generated config.toml
		exists, err := afero.Exists(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated .gitignore
		exists, err = afero.Exists(fsys, utils.GitIgnorePath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated seed.sql
		exists, err = afero.Exists(fsys, utils.SeedDataPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate vscode workspace isn't generated
		exists, err = afero.Exists(fsys, filepath.Join(cwd, "init.code-workspace"))
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("throws error when config file exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(fsys, nil))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.StatErrorFs{DenyPath: utils.ConfigPath}
		// Run test
		err := Run(fsys, nil)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on failure to write config", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(fsys, nil))
	})

	t.Run("throws error on seed failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.CreateErrorFs{DenyPath: utils.SeedDataPath}
		// Run test
		err := Run(fsys, nil)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("creates vscode workspace file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		assert.NoError(t, Run(fsys, boolPointer(true)))
		// Validate generated vscode workspace
		exists, err := afero.Exists(fsys, filepath.Join(cwd, "init.code-workspace"))
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("does not create vscode workspace file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		assert.NoError(t, Run(fsys, boolPointer(false)))
		// Validate vscode workspace isn't generated
		exists, err := afero.Exists(fsys, filepath.Join(cwd, "init.code-workspace"))
		assert.NoError(t, err)
		assert.False(t, exists)
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

func boolPointer(b bool) *bool {
	return &b
}
