package utils

import (
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/zalando/go-keyring"
)

func TestLoadToken(t *testing.T) {
	keyring.MockInit()
	token := string(apitest.RandomAccessToken(t))

	t.Run("loads token from env var", func(t *testing.T) {
		t.Setenv("SUPABASE_ACCESS_TOKEN", token)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		loaded, err := LoadAccessTokenFS(fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, token, loaded)
	})

	t.Run("throws error on invalid token", func(t *testing.T) {
		t.Setenv("SUPABASE_ACCESS_TOKEN", "invalid")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		loaded, err := LoadAccessTokenFS(fsys)
		// Check error
		assert.ErrorIs(t, err, ErrInvalidToken)
		assert.Empty(t, loaded)
	})

	t.Run("throws error on missing token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		loaded, err := LoadAccessTokenFS(fsys)
		// Check error
		assert.ErrorIs(t, err, ErrMissingToken)
		assert.Empty(t, loaded)
	})
}

func TestLoadTokenFallback(t *testing.T) {
	t.Run("fallback loads from file", func(t *testing.T) {
		path, err := getAccessTokenPath()
		assert.NoError(t, err)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, path, []byte{}, 0600))
		// Run test
		token, err := fallbackLoadToken(fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, token)
	})

	t.Run("throws error on home dir failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup empty home directory
		t.Setenv("HOME", "")
		// Run test
		token, err := fallbackLoadToken(fsys)
		// Check error
		assert.ErrorContains(t, err, "$HOME is not defined")
		assert.Empty(t, token)
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		path, err := getAccessTokenPath()
		assert.NoError(t, err)
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: path}
		// Run test
		token, err := fallbackLoadToken(fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
		assert.Empty(t, token)
	})
}

func TestSaveToken(t *testing.T) {
	keyring.MockInit()
	token := string(apitest.RandomAccessToken(t))

	t.Run("saves token to keyring", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, SaveAccessToken(token, fsys))
		// Validate saved token
		saved, err := LoadAccessTokenFS(fsys)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
	})

	t.Run("throws error on invalid token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := SaveAccessToken("invalid", fsys)
		// Check error
		assert.ErrorIs(t, err, ErrInvalidToken)
	})
}

func TestSaveTokenFallback(t *testing.T) {
	token := string(apitest.RandomAccessToken(t))

	t.Run("fallback saves to file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, fallbackSaveToken(token, fsys))
		// Validate saved token
		path, err := getAccessTokenPath()
		assert.NoError(t, err)
		contents, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, []byte(token), contents)
	})

	t.Run("throws error on home dir failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup empty home directory
		t.Setenv("HOME", "")
		// Run test
		err := fallbackSaveToken(token, fsys)
		// Check error
		assert.ErrorContains(t, err, "$HOME is not defined")
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		err := fallbackSaveToken(token, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		home, err := os.UserHomeDir()
		assert.NoError(t, err)
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: home}
		// Run test
		err = fallbackSaveToken(token, fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}
