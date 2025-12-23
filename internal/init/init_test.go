package init

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestInitCommand(t *testing.T) {
	t.Run("creates config file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		require.NoError(t, fsys.Mkdir(".git", 0755))
		// Run test (non-interactive mode)
		assert.NoError(t, Run(context.Background(), fsys, false, utils.InitParams{}))
		// Validate generated config.toml
		exists, err := afero.Exists(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated signing key
		signingKeysPath := filepath.Join(utils.SupabaseDirPath, "signing_keys.json")
		exists, err = afero.Exists(fsys, signingKeysPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate generated .gitignore
		exists, err = afero.Exists(fsys, utils.GitIgnorePath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate vscode settings file isn't generated
		exists, err = afero.Exists(fsys, settingsPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		exists, err = afero.Exists(fsys, extensionsPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		// Validate intellij settings file isn't generated
		exists, err = afero.Exists(fsys, denoPath)
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("throws error when config file exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create(utils.ConfigPath)
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run(context.Background(), fsys, false, utils.InitParams{}))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.ConfigPath}
		// Run test
		err := Run(context.Background(), fsys, false, utils.InitParams{})
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on failure to write config", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(context.Background(), fsys, false, utils.InitParams{}))
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
		err := WriteVscodeConfig(afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on extensions failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: extensionsPath}
		// Run test
		err := WriteVscodeConfig(fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on settings failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: settingsPath}
		// Run test
		err := WriteVscodeConfig(fsys)
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

func TestGenerateDefaultSigningKey(t *testing.T) {
	signingKeysPath := filepath.Join(utils.SupabaseDirPath, "signing_keys.json")

	t.Run("generates signing key when file doesn't exist", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, generateDefaultSigningKey(fsys))
		// Validate file exists
		exists, err := afero.Exists(fsys, signingKeysPath)
		assert.NoError(t, err)
		assert.True(t, exists)
		// Validate file contents
		content, err := afero.ReadFile(fsys, signingKeysPath)
		assert.NoError(t, err)
		var jwkArray []config.JWK
		assert.NoError(t, json.Unmarshal(content, &jwkArray))
		assert.Len(t, jwkArray, 1)
		// Validate key structure
		key := jwkArray[0]
		assert.Equal(t, "RSA", key.KeyType)
		assert.Equal(t, config.Algorithm("RS256"), key.Algorithm)
		assert.NotEmpty(t, key.KeyID)
		assert.NotEmpty(t, key.Modulus)
		assert.NotEmpty(t, key.Exponent)
		assert.NotEmpty(t, key.PrivateExponent)
	})

	t.Run("skips generation when file already exists", func(t *testing.T) {
		// Setup in-memory fs with existing key file
		fsys := afero.NewMemMapFs()
		existingKey := []config.JWK{
			{
				KeyType:   "RSA",
				KeyID:     "existing-key-id",
				Algorithm: config.AlgRS256,
			},
		}
		existingContent, err := json.Marshal(existingKey)
		require.NoError(t, err)
		require.NoError(t, utils.MkdirIfNotExistFS(fsys, utils.SupabaseDirPath))
		require.NoError(t, afero.WriteFile(fsys, signingKeysPath, existingContent, 0600))
		// Run test
		assert.NoError(t, generateDefaultSigningKey(fsys))
		// Validate file wasn't modified
		content, err := afero.ReadFile(fsys, signingKeysPath)
		assert.NoError(t, err)
		var jwkArray []config.JWK
		assert.NoError(t, json.Unmarshal(content, &jwkArray))
		assert.Len(t, jwkArray, 1)
		assert.Equal(t, "existing-key-id", jwkArray[0].KeyID)
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		err := generateDefaultSigningKey(fsys)
		// Check error
		assert.Error(t, err)
		assert.ErrorContains(t, err, "failed to create supabase directory")
	})

	t.Run("throws error on failure to create file", func(t *testing.T) {
		// Setup fs that denies file creation
		// OpenErrorFs will fail when trying to open/create the file
		fsys := &fstest.OpenErrorFs{DenyPath: signingKeysPath}
		// Run test
		err := generateDefaultSigningKey(fsys)
		// Check error - OpenErrorFs will fail on OpenFile call
		assert.Error(t, err)
		assert.ErrorContains(t, err, "failed to create signing key file")
	})
}
