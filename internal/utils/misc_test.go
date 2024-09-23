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

func TestGetSeedFiles(t *testing.T) {
	t.Run("returns seed files matching patterns", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Create seed files
		require.NoError(t, afero.WriteFile(fsys, "seeds/seed1.sql", []byte("INSERT INTO table1 VALUES (1);"), 0644))
		require.NoError(t, afero.WriteFile(fsys, "seeds/seed2.sql", []byte("INSERT INTO table2 VALUES (2);"), 0644))
		require.NoError(t, afero.WriteFile(fsys, "seeds/seed3.sql", []byte("INSERT INTO table2 VALUES (2);"), 0644))
		require.NoError(t, afero.WriteFile(fsys, "seeds/another.sql", []byte("INSERT INTO table2 VALUES (2);"), 0644))
		require.NoError(t, afero.WriteFile(fsys, "seeds/ignore.sql", []byte("INSERT INTO table3 VALUES (3);"), 0644))
		// Mock config patterns
		Config.Db.Seed.Path = []string{"seeds/seed[12].sql", "seeds/ano*.sql"}

		// Run test
		files, err := GetSeedFiles(fsys)

		// Check error
		assert.NoError(t, err)
		// Validate files
		assert.ElementsMatch(t, []string{"seeds/seed1.sql", "seeds/seed2.sql", "seeds/another.sql"}, files)
	})

	t.Run("returns error on invalid pattern", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Mock config patterns
		Config.Db.Seed.Path = []string{"[invalid pattern"}

		// Run test
		files, err := GetSeedFiles(fsys)

		// Check error
		assert.Nil(t, err)
		// The resuling seed list should be empty
		assert.ElementsMatch(t, []string{}, files)
	})

	t.Run("returns empty list if no files match", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Mock config patterns
		Config.Db.Seed.Path = []string{"seeds/*.sql"}

		// Run test
		files, err := GetSeedFiles(fsys)

		// Check error
		assert.NoError(t, err)
		// Validate files
		assert.Empty(t, files)
	})
}
