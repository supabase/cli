package new

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestNewCommand(t *testing.T) {
	t.Run("creates new function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", fsys))
		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		content, err := afero.ReadFile(fsys, funcPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content),
			"curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/test-func'",
		)

		// Verify config.toml is updated
		_, err = afero.ReadFile(fsys, utils.ConfigPath)
		assert.NoError(t, err, "config.toml should be created")

		// Verify deno.json exists
		denoPath := filepath.Join(utils.FunctionsDir, "test-func", "deno.json")
		_, err = afero.ReadFile(fsys, denoPath)
		assert.NoError(t, err, "deno.json should be created")

		// Verify .npmrc exists
		npmrcPath := filepath.Join(utils.FunctionsDir, "test-func", ".npmrc")
		_, err = afero.ReadFile(fsys, npmrcPath)
		assert.NoError(t, err, ".npmrc should be created")
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), "@", afero.NewMemMapFs()))
	})

	t.Run("throws error on duplicate slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, funcPath, []byte{}, 0644))
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", fsys))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", fsys))
	})
}
