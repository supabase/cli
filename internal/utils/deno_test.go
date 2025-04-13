package utils

import (
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
