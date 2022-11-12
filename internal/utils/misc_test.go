package utils

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type MockFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *MockFs) Stat(name string) (fs.FileInfo, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Stat(name)
}

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

	t.Run("ignores error if path is not directory", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Setup in-memory fs
		fsys := &MockFs{DenyPath: filepath.Join(cwd, "supabase")}
		// Run test
		path, err := GetProjectRoot(fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, cwd, path)
	})
}
