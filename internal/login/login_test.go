package login

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
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
	keyring.MockInit()

	t.Run("prompts and validates api token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup input with random token
		token := randomToken(t)
		stdin := bytes.NewBuffer(token)
		// Run test
		assert.NoError(t, Run(stdin, fsys))
		// Validate saved token
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, string(token), saved)
	})

	t.Run("cancels when no input", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup dependencies
		stdin := &bytes.Buffer{}
		// Run test
		assert.NoError(t, Run(stdin, fsys))
	})

	t.Run("throws error on invalid token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup malformed token
		stdin := bytes.NewBufferString("malformed")
		// Run test
		assert.Error(t, Run(stdin, fsys))
	})
}

func TestSaveToken(t *testing.T) {
	const token = "test-token"

	t.Run("fallback saves to file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, fallbackSaveToken(token, fsys))
		// Validate saved token
		home, err := os.UserHomeDir()
		assert.NoError(t, err)
		path := filepath.Join(home, ".supabase", utils.AccessTokenKey)
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
		fsys := &MockFs{DenyPath: home}
		// Run test
		err = fallbackSaveToken(token, fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}

type MockFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *MockFs) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.OpenFile(name, flag, perm)
}
