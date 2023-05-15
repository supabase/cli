package utils

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveImports(t *testing.T) {
	t.Run("resolves relative directory", func(t *testing.T) {
		importMap := &ImportMap{
			Imports: map[string]string{
				"abs/":    "/tmp/",
				"root":    "../../common",
				"parent":  "../tests",
				"child":   "child",
				"missing": "../missing",
			},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		cwd, err := os.Getwd()
		require.NoError(t, err)
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, "common"), 0755))
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, DbTestsDir), 0755))
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, FunctionsDir, "child"), 0755))
		// Run test
		resolved := importMap.Resolve(fsys)
		// Check error
		assert.Equal(t, "/home/deno/modules/ac351c7174c8f47a9a9056bd96bcd71cfb980c906daee74ab9bce8308c68b811/", resolved.Imports["abs/"])
		assert.Equal(t, "/home/deno/modules/92a5dc04bd6f9fb8f29f8066fed8a5c1e81bc59ad48a11283b63736867e4f2a8", resolved.Imports["root"])
		assert.Equal(t, "/home/deno/modules/faaed96206118cf98625ea8065b6b3864f8cf9484814c423b58ebaa9b2d1e47b", resolved.Imports["parent"])
		assert.Equal(t, "child", resolved.Imports["child"])
		assert.Equal(t, "../missing", resolved.Imports["missing"])
	})

	t.Run("resolves parent scopes", func(t *testing.T) {
		importMap := &ImportMap{
			Scopes: map[string]map[string]string{
				"my-scope": {
					"my-mod": "https://deno.land",
				},
			},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		resolved := importMap.Resolve(fsys)
		// Check error
		assert.Equal(t, "https://deno.land", resolved.Scopes["my-scope"]["my-mod"])
	})
}

func TestImportMapPath(t *testing.T) {
	t.Run("loads import map from default location", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, []byte("{}"), 0644))
		absPath, err := filepath.Abs(FallbackImportMapPath)
		require.NoError(t, err)
		require.NoError(t, afero.WriteFile(fsys, absPath, []byte("{}"), 0644))
		// Run test
		resolved, err := AbsImportMapPath("", "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, absPath, resolved)
	})

	t.Run("per function config takes precedence", func(t *testing.T) {
		slug := "hello"
		Config.Functions = map[string]function{
			slug: {ImportMap: "import_map.json"},
		}
		absPath, err := filepath.Abs("supabase/import_map.json")
		require.NoError(t, err)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, []byte("{}"), 0644))
		require.NoError(t, afero.WriteFile(fsys, absPath, []byte("{}"), 0644))
		// Run test
		resolved, err := AbsImportMapPath("", slug, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, absPath, resolved)
	})

	t.Run("returns empty string if no fallback", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		resolved, err := AbsImportMapPath("", "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, resolved)
	})

	t.Run("throws error on missing file", func(t *testing.T) {
		path := "/tmp/import_map"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		resolved, err := AbsImportMapPath(path, "", fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
		assert.Empty(t, resolved)
	})

	t.Run("throws error on importing directory", func(t *testing.T) {
		path := "/tmp/import_map"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.MkdirAll(path, 0755))
		// Run test
		resolved, err := AbsImportMapPath(path, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Importing directory is unsupported: "+path)
		assert.Empty(t, resolved)
	})
}
