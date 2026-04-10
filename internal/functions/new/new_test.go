package new

import (
	"context"
	"fmt"
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
		assert.NoError(t, Run(context.Background(), "test-func", AuthAccessModeAlways, fsys))
		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		content, err := afero.ReadFile(fsys, funcPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content),
			"curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/test-func'",
		)

		// Verify config.toml is updated
		content, err = afero.ReadFile(fsys, utils.ConfigPath)
		assert.NoError(t, err, "config.toml should be created")
		assert.Contains(t, string(content), "[functions.test-func]")
		// Always access mode should not verify jwt
		assert.Contains(t, string(content), "verify_jwt = false")

		// Verify deno.json exists
		denoPath := filepath.Join(utils.FunctionsDir, "test-func", "deno.json")
		_, err = afero.ReadFile(fsys, denoPath)
		assert.NoError(t, err, "deno.json should be created")

		// Verify .npmrc exists
		npmrcPath := filepath.Join(utils.FunctionsDir, "test-func", ".npmrc")
		_, err = afero.ReadFile(fsys, npmrcPath)
		assert.NoError(t, err, ".npmrc should be created")
	})

	t.Run("creates new function with apikey access", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.NoError(t, Run(context.Background(), "test-func", AuthAccessModeApiKey, fsys))

		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		content, _ := afero.ReadFile(fsys, funcPath)
		// Should contain the PublishableKey as example
		assert.Contains(t, string(content), fmt.Sprintf("--header 'apiKey: %v'", utils.Config.Auth.PublishableKey.Value))

		// Verify config.toml is updated to not verify jwt
		content, _ = afero.ReadFile(fsys, utils.ConfigPath)
		assert.Contains(t, string(content), "verify_jwt = false")
	})

	t.Run("creates new function with user access", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.NoError(t, Run(context.Background(), "test-func", AuthAccessModeUser, fsys))

		// Validate output
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		content, _ := afero.ReadFile(fsys, funcPath)
		// Should contain the PublishableKey as example as well placeholder for UserToken
		assert.Contains(t, string(content), fmt.Sprintf("--header 'apiKey: %v'", utils.Config.Auth.PublishableKey.Value))
		assert.Contains(t, string(content), "--header 'Authorization: Bearer <UserToken>'")

		// Verify config.toml is updated and verify jwt enabled
		content, _ = afero.ReadFile(fsys, utils.ConfigPath)
		assert.Contains(t, string(content), "verify_jwt = true")
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), "@", AuthAccessModeAlways, afero.NewMemMapFs()))
	})

	t.Run("throws error on duplicate slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		funcPath := filepath.Join(utils.FunctionsDir, "test-func", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, funcPath, []byte{}, 0o644))
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", AuthAccessModeAlways, fsys))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run(context.Background(), "test-func", AuthAccessModeAlways, fsys))
	})
}
