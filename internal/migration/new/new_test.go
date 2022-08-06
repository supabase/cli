package new

import (
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
)

func TestNewCommand(t *testing.T) {
	t.Run("creates new migration file", func(t *testing.T) {
		assert.NoError(t, Run("test_migrate", afero.NewMemMapFs()))
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Run test
		assert.Error(t, Run("test_migrate", fsys))
	})
}
