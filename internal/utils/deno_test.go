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
		resolved, err := newImportMap(jsonPath, fsys)
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
		resolved, err := newImportMap(FallbackImportMapPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "https://deno.land", resolved.Scopes["my-scope"]["my-mod"])
	})
}

func TestBindModules(t *testing.T) {
	t.Run("binds docker imports", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		entrypoint := `import "https://deno.land"
import "/tmp/index.ts"
import "../common/index.ts"
import "../../../supabase/tests/index.ts"
import "./child/index.ts"`
		require.NoError(t, WriteFile("/app/supabase/functions/hello/index.ts", []byte(entrypoint), fsys))
		require.NoError(t, WriteFile("/tmp/index.ts", []byte{}, fsys))
		require.NoError(t, WriteFile("/app/supabase/functions/common/index.ts", []byte{}, fsys))
		require.NoError(t, WriteFile("/app/supabase/tests/index.ts", []byte{}, fsys))
		require.NoError(t, WriteFile("/app/supabase/functions/hello/child/index.ts", []byte{}, fsys))
		// Run test
		mods, err := BindHostModules("/app", "supabase/functions/hello/index.ts", "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, mods, []string{
			"/app/supabase/functions/hello/index.ts:/app/supabase/functions/hello/index.ts:ro",
			"/tmp/index.ts:/tmp/index.ts:ro",
			"/app/supabase/functions/common/index.ts:/app/supabase/functions/common/index.ts:ro",
			"/app/supabase/tests/index.ts:/app/supabase/tests/index.ts:ro",
			"/app/supabase/functions/hello/child/index.ts:/app/supabase/functions/hello/child/index.ts:ro",
		})
	})
}
