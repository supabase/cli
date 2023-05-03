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
				"abs":     "/tmp",
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
		assert.Equal(t, "/home/deno/modules/e9671acd244849c57167c658fa2f969752048f7ab184a3dcf5c46cb4d56ae124", resolved.Imports["abs"])
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
