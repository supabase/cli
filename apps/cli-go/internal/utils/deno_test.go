package utils

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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

func TestGetDenoPath(t *testing.T) {
	t.Run("returns override path when set", func(t *testing.T) {
		override := "/custom/path/to/deno"
		DenoPathOverride = override
		defer func() { DenoPathOverride = "" }()

		path, err := GetDenoPath()

		assert.NoError(t, err)
		assert.Equal(t, override, path)
	})

	t.Run("returns default path", func(t *testing.T) {
		home, err := os.UserHomeDir()
		require.NoError(t, err)
		expected := filepath.Join(home, ".supabase", "deno")
		if runtime.GOOS == "windows" {
			expected += ".exe"
		}

		path, err := GetDenoPath()

		assert.NoError(t, err)
		assert.Equal(t, expected, path)
	})
}

func TestIsScriptModified(t *testing.T) {
	t.Run("detects modified script", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		destPath := "/path/to/script.ts"
		original := []byte("original content")
		modified := []byte("modified content")
		require.NoError(t, afero.WriteFile(fsys, destPath, modified, 0644))

		isModified, err := isScriptModified(fsys, destPath, original)

		assert.NoError(t, err)
		assert.True(t, isModified)
	})

	t.Run("detects unmodified script", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		destPath := "/path/to/script.ts"
		content := []byte("test content")
		require.NoError(t, afero.WriteFile(fsys, destPath, content, 0644))

		isModified, err := isScriptModified(fsys, destPath, content)

		assert.NoError(t, err)
		assert.False(t, isModified)
	})

	t.Run("handles non-existent script", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		destPath := "/path/to/script.ts"
		content := []byte("test content")

		isModified, err := isScriptModified(fsys, destPath, content)

		assert.NoError(t, err)
		assert.True(t, isModified)
	})
}

func TestCopyDenoScripts(t *testing.T) {
	t.Run("copies deno scripts", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		home, err := os.UserHomeDir()
		require.NoError(t, err)
		denoDir := filepath.Join(home, ".supabase")
		require.NoError(t, fsys.MkdirAll(denoDir, 0755))

		scripts, err := CopyDenoScripts(context.Background(), fsys)

		assert.NoError(t, err)
		assert.NotNil(t, scripts)
		extractExists, err := afero.Exists(fsys, scripts.ExtractPath)
		assert.NoError(t, err)
		assert.True(t, extractExists)
	})

	t.Run("skips copying unmodified scripts", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		home, err := os.UserHomeDir()
		require.NoError(t, err)
		scriptDir := filepath.Join(home, ".supabase", "denos")
		require.NoError(t, fsys.MkdirAll(scriptDir, 0755))

		scripts1, err := CopyDenoScripts(context.Background(), fsys)
		require.NoError(t, err)
		stat1, err := fsys.Stat(scripts1.ExtractPath)
		require.NoError(t, err)
		modTime1 := stat1.ModTime()

		// Second copy
		scripts2, err := CopyDenoScripts(context.Background(), fsys)
		require.NoError(t, err)
		stat2, err := fsys.Stat(scripts2.ExtractPath)
		require.NoError(t, err)
		modTime2 := stat2.ModTime()

		// Verify file wasn't rewritten
		assert.Equal(t, modTime1, modTime2)
	})
}
