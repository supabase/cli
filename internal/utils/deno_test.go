package utils

import (
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
				"child":   "child/",
				"missing": "../missing",
			},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.Mkdir("common", 0755))
		require.NoError(t, fsys.Mkdir(DbTestsDir, 0755))
		require.NoError(t, fsys.Mkdir(filepath.Join(FunctionsDir, "child"), 0755))
		// Run test
		resolved := importMap.Resolve(fsys)
		// Check error
		assert.Equal(t, "/home/deno/modules/ac351c7174c8f47a9a9056bd96bcd71cfb980c906daee74ab9bce8308c68b811/", resolved.Imports["abs/"])
		assert.Equal(t, "/home/deno/modules/92a5dc04bd6f9fb8f29f8066fed8a5c1e81bc59ad48a11283b63736867e4f2a8", resolved.Imports["root"])
		assert.Equal(t, "/home/deno/modules/faaed96206118cf98625ea8065b6b3864f8cf9484814c423b58ebaa9b2d1e47b", resolved.Imports["parent"])
		assert.Equal(t, "/home/deno/functions/child/", resolved.Imports["child"])
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
		// Run test
		fc := GetFunctionConfig("", "", nil, fsys)
		// Check error
		assert.Equal(t, FallbackImportMapPath, fc.ImportMap)
	})

	t.Run("per function config takes precedence", func(t *testing.T) {
		slug := "hello"
		Config.Functions = map[string]function{
			slug: {ImportMap: "import_map.json"},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc := GetFunctionConfig(slug, "", nil, fsys)
		// Check error
		assert.Equal(t, "supabase/import_map.json", fc.ImportMap)
	})

	t.Run("overrides with cli flag", func(t *testing.T) {
		slug := "hello"
		Config.Functions = map[string]function{
			slug: {ImportMap: "import_map.json"},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc := GetFunctionConfig(slug, FallbackImportMapPath, Ptr(false), fsys)
		// Check error
		assert.Equal(t, FallbackImportMapPath, fc.ImportMap)
	})

	t.Run("returns empty string if no fallback", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		fc := GetFunctionConfig("", "", nil, fsys)
		// Check error
		assert.Empty(t, fc.ImportMap)
	})

	t.Run("preserves absolute path", func(t *testing.T) {
		path := "/tmp/import_map.json"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc := GetFunctionConfig("", path, nil, fsys)
		// Check error
		assert.Equal(t, path, fc.ImportMap)
	})
}
