package init

import (
	"encoding/json"
	"os"
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
		require.NoError(t, fsys.Mkdir(".git", 0755))
		// Run test
		assert.NoError(t, Run(fsys, nil, false))
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
		// Validate vscode settings file isn't generated
		exists, err = afero.Exists(fsys, settingsPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		exists, err = afero.Exists(fsys, extensionsPath)
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("throws error when config file exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(fsys, nil, false))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.StatErrorFs{DenyPath: utils.ConfigPath}
		// Run test
		err := Run(fsys, nil, false)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on failure to write config", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(fsys, nil, false))
	})

	t.Run("throws error on seed failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.CreateErrorFs{DenyPath: utils.SeedDataPath}
		// Run test
		err := Run(fsys, nil, false)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("creates vscode settings file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		// Run test
		assert.NoError(t, Run(fsys, boolPointer(true), false))
		// Validate generated vscode settings
		exists, err := afero.Exists(fsys, settingsPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		exists, err = afero.Exists(fsys, extensionsPath)
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("does not create vscode settings file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		// Run test
		assert.NoError(t, Run(fsys, boolPointer(false), false))
		// Validate vscode settings file isn't generated
		exists, err := afero.Exists(fsys, settingsPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		exists, err = afero.Exists(fsys, extensionsPath)
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

	t.Run("throws error on failure to open", func(t *testing.T) {
		// Setup read-only fs
		fsys := &fstest.OpenErrorFs{DenyPath: ignorePath}
		// Run test
		err := updateGitIgnore(ignorePath, fsys)
		// Check error
		assert.Error(t, err, os.ErrPermission)
	})

	t.Run("throws error on failure to create", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		err := updateGitIgnore(ignorePath, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})
}

func TestWriteVSCodeConfig(t *testing.T) {
	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := writeVscodeConfig(afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on extensions failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: extensionsPath}
		// Run test
		err := writeVscodeConfig(fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on settings failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: settingsPath}
		// Run test
		err := writeVscodeConfig(fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}

func TestUpdateJsonFile(t *testing.T) {
	t.Run("overwrites empty settings with template", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, settingsPath, []byte{}, 0644))
		// Run test
		err := updateJsonFile(settingsPath, "{}", fsys)
		// Check error
		assert.NoError(t, err)
		contents, err := afero.ReadFile(fsys, settingsPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("{}"), contents)
	})

	t.Run("merges template into user settings", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, settingsPath, []byte(`{"a": true, "b": 123}`), 0644))
		// Run test
		err := updateJsonFile(settingsPath, `{"b": 456, "c": false}`, fsys)
		// Check error
		assert.NoError(t, err)
		f, err := fsys.Open(settingsPath)
		assert.NoError(t, err)
		var settings VSCodeSettings
		dec := json.NewDecoder(f)
		assert.NoError(t, dec.Decode(&settings))
		assert.Equal(t, VSCodeSettings{
			"a": true,
			"b": float64(456),
			"c": false,
		}, settings)
	})

	t.Run("throws error on merge failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, settingsPath, []byte("{}"), 0644))
		// Run test
		err := updateJsonFile(settingsPath, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to copy template:")
	})

	t.Run("throws error on save failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, settingsPath, []byte("{}"), 0644))
		// Run test
		err := updateJsonFile(settingsPath, "{}", afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})
}

func boolPointer(b bool) *bool {
	return &b
}
