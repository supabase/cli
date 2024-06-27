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
	root := string(filepath.Separator)

	t.Run("stops at root dir", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(filepath.Join(root, ConfigPath))
		require.NoError(t, err)
		// Run test
		cwd := filepath.Join(root, "home", "user", "project")
		path := getProjectRoot(cwd, fsys)
		// Check error
		assert.Equal(t, root, path)
	})

	t.Run("stops at closest parent", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(filepath.Join(root, "supabase", ConfigPath))
		require.NoError(t, err)
		// Run test
		cwd := filepath.Join(root, "supabase", "supabase", "functions")
		path := getProjectRoot(cwd, fsys)
		// Check error
		assert.Equal(t, filepath.Join(root, "supabase"), path)
	})

	t.Run("ignores error on config not found", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		path := getProjectRoot(cwd, fsys)
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
		path := getProjectRoot(cwd, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, cwd, path)
	})
}
