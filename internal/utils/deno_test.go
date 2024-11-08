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
		importMap := []byte(`{
	"imports": {
		"abs/":    "/tmp/",
		"root":    "../../common",
		"parent":  "../tests",
		"child":   "child/",
		"missing": "../missing"
	}
}`)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		cwd, err := os.Getwd()
		require.NoError(t, err)
		jsonPath := filepath.Join(cwd, FallbackImportMapPath)
		require.NoError(t, afero.WriteFile(fsys, jsonPath, importMap, 0644))
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, "common"), 0755))
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, DbTestsDir), 0755))
		require.NoError(t, fsys.Mkdir(filepath.Join(cwd, FunctionsDir, "child"), 0755))
		// Run test
		resolved, err := NewImportMap(jsonPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "/tmp/", resolved.Imports["abs/"])
		assert.Equal(t, cwd+"/common", resolved.Imports["root"])
		assert.Equal(t, cwd+"/supabase/tests", resolved.Imports["parent"])
		assert.Equal(t, cwd+"/supabase/functions/child/", resolved.Imports["child"])
		assert.Equal(t, "../missing", resolved.Imports["missing"])
	})

	t.Run("resolves parent scopes", func(t *testing.T) {
		importMap := []byte(`{
	"scopes": {
		"my-scope": {
			"my-mod": "https://deno.land"
		}
	}
}`)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, FallbackImportMapPath, importMap, 0644))
		// Run test
		resolved, err := NewImportMap(FallbackImportMapPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "https://deno.land", resolved.Scopes["my-scope"]["my-mod"])
	})
}

func TestBindModules(t *testing.T) {
	t.Run("binds docker imports", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		importMap := ImportMap{
			Imports: map[string]string{
				"abs/":   "/tmp/",
				"root":   cwd + "/common",
				"parent": cwd + "/supabase/tests",
				"child":  cwd + "/supabase/functions/child/",
			},
		}
		// Run test
		mods := importMap.BindHostModules()
		// Check error
		assert.ElementsMatch(t, mods, []string{
			"/tmp/:/tmp/:ro",
			cwd + "/common:" + cwd + "/common:ro",
			cwd + "/supabase/tests:" + cwd + "/supabase/tests:ro",
		})
	})

	t.Run("binds docker scopes", func(t *testing.T) {
		importMap := ImportMap{
			Scopes: map[string]map[string]string{
				"my-scope": {
					"my-mod": "https://deno.land",
				},
			},
		}
		// Run test
		mods := importMap.BindHostModules()
		// Check error
		assert.Empty(t, mods)
	})
}
