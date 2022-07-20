package login

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func randomToken(t *testing.T) []byte {
	data := make([]byte, 20)
	_, err := rand.Read(data)
	require.NoError(t, err)
	token := make([]byte, 44)
	copy(token, "sbp_")
	hex.Encode(token[4:], data)
	return token
}

func TestLoginCommand(t *testing.T) {
	t.Run("prompts and validates api token", func(t *testing.T) {
		// Setup input with random token
		token := randomToken(t)
		stdin := bytes.NewBuffer(token)
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, Run(stdin, fsys))
		// Validate saved token
		home, err := os.UserHomeDir()
		assert.NoError(t, err)
		accessToken := filepath.Join(home, ".supabase", "access-token")
		content, err := afero.ReadFile(fsys, accessToken)
		assert.NoError(t, err)
		assert.Equal(t, token, content)
	})

	t.Run("cancels when no input", func(t *testing.T) {
		// Setup dependencies
		stdin := bytes.Buffer{}
		fsys := afero.MemMapFs{}
		// Run test
		assert.NoError(t, Run(&stdin, &fsys))
	})

	t.Run("throws error on invalid token", func(t *testing.T) {
		// Setup malformed token
		stdin := bytes.NewBufferString("malformed")
		fsys := afero.NewMemMapFs()
		// Run test
		assert.Error(t, Run(stdin, fsys))
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		token := randomToken(t)
		stdin := bytes.NewBuffer(token)
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(stdin, fsys))
	})

	t.Run("throws error on failure to get home", func(t *testing.T) {
		// Setup empty home directory
		token := randomToken(t)
		stdin := bytes.NewBuffer(token)
		fsys := afero.NewMemMapFs()
		// Run test
		t.Setenv("HOME", "")
		assert.Error(t, Run(stdin, fsys))
	})

	// TODO: throws error on failure to save token
}
