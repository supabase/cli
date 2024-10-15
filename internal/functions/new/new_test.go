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
		require.NoError(t, fsys.MkdirAll(utils.FunctionsDir, 0755))
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", "", fsys))
		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		content, err := afero.ReadFile(fsys, funcPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content),
			"curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/test-func'",
		)
	})

	t.Run("creates new JS function when lang==js flag is set", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", "js", fsys))
		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.js")
		content, err := afero.ReadFile(fsys, funcPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content),
			"curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/test-func'",
		)
	})

	t.Run("creates new JS function when default language is set to javascript in config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.MkdirAll(utils.FunctionsDir, 0755))
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test", EdgeRuntimeDefaultLanguage: "javascript"}, fsys))

		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", "", fsys))
		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.js")
		content, err := afero.ReadFile(fsys, funcPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content),
			"curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/test-func'",
		)
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), "@", "", afero.NewMemMapFs()))
	})

	t.Run("throws error on duplicate slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, funcPath, []byte{}, 0644))
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", "", fsys))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", "", fsys))
	})
}
