package init

import (
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInitCommand(t *testing.T) {
	t.Run("creates config file", func(t *testing.T) {
		fsys := &afero.MemMapFs{}
		assert.NoError(t, Run(fsys))
		// TODO: verify .gitignore
		exists, err := afero.Exists(fsys, "supabase/config.toml")
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("errors when config file exists", func(t *testing.T) {
		// Test setup
		fsys := &afero.MemMapFs{}
		_, err := fsys.Create("supabase/config.toml")
		require.NoError(t, err)
		// Actual test
		assert.Error(t, Run(fsys))
	})
}
