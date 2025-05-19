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

func TestShortContainerImageName(t *testing.T) {
	t.Run("extracts short name from image", func(t *testing.T) {
		input := "registry.supabase.com/postgres:15.1.0.99"
		expected := "postgres"

		result := ShortContainerImageName(input)

		assert.Equal(t, expected, result)
	})
}

func TestIsBranchNameReserved(t *testing.T) {
	t.Run("identifies reserved names", func(t *testing.T) {
		reserved := []string{"_current_branch", "main"}
		for _, name := range reserved {
			assert.True(t, IsBranchNameReserved(name), "Expected %s to be reserved", name)
		}
	})

	t.Run("allows custom names", func(t *testing.T) {
		allowed := []string{"my-feature", "test-branch-123"}
		for _, name := range allowed {
			assert.False(t, IsBranchNameReserved(name), "Expected %s to be allowed", name)
		}
	})
}

func TestValidateFunctionSlug(t *testing.T) {
	t.Run("validates correct slugs", func(t *testing.T) {
		valid := []string{
			"my-function",
			"MyFunction",
			"function_1",
			"a123",
		}
		for _, slug := range valid {
			err := ValidateFunctionSlug(slug)
			assert.NoError(t, err, "Expected %s to be valid", slug)
		}
	})

	t.Run("rejects invalid slugs", func(t *testing.T) {
		invalid := []string{
			"1function",
			"my function",
			"function!",
			"",
			"-function",
			"_function",
		}
		for _, slug := range invalid {
			err := ValidateFunctionSlug(slug)
			assert.ErrorIs(t, err, ErrInvalidSlug, "Expected %s to be invalid", slug)
		}
	})
}

func TestAssertProjectRefIsValid(t *testing.T) {
	t.Run("validates correct refs", func(t *testing.T) {
		validRef := "abcdefghijklmnopqrst"
		err := AssertProjectRefIsValid(validRef)
		assert.NoError(t, err)
	})

	t.Run("rejects invalid refs", func(t *testing.T) {
		invalid := []string{
			"tooshort",
			"toolongabcdefghijklmnopqrst",
			"UPPERCASE",
			"special-chars",
			"123",
			"",
		}
		for _, ref := range invalid {
			err := AssertProjectRefIsValid(ref)
			assert.ErrorIs(t, err, ErrInvalidRef, "Expected %s to be invalid", ref)
		}
	})
}

func TestWriteFile(t *testing.T) {
	t.Run("writes file with directories", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		path := filepath.Join("deep", "nested", "dir", "file.txt")
		content := []byte("test content")

		err := WriteFile(path, content, fsys)

		assert.NoError(t, err)

		written, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, content, written)
	})

	t.Run("overwrites existing file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		path := "test.txt"
		original := []byte("original")
		updated := []byte("updated")
		require.NoError(t, afero.WriteFile(fsys, path, original, 0644))

		err := WriteFile(path, updated, fsys)

		assert.NoError(t, err)
		written, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, updated, written)
	})
}
