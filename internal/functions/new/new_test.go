package new

import (
	"context"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewCommand(t *testing.T) {
	t.Run("creates new function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		assert.NoError(t, Run(context.Background(), "test-func", fsys))
		// Validate output
		content, err := afero.ReadFile(fsys, "supabase/functions/test-func/index.ts")
		assert.NoError(t, err)
		assert.Equal(t, index, string(content))
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), "@", afero.NewMemMapFs()))
	})

	t.Run("throws error on duplicate slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.Mkdir("supabase/functions/test-func", 0755))
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
