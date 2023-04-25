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

func TestCreatePgTAP(t *testing.T) {
	t.Run("creates test file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "pet", fsys)
		// Check error
		assert.NoError(t, err)
		f, err := fsys.Stat(filepath.Join(utils.DbTestsDir, "pet_test.sql"))
		assert.NoError(t, err)
		assert.EqualValues(t, len(pgtapTest), f.Size())
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "pet", afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on file exists", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		_, err := fsys.Create(filepath.Join(utils.DbTestsDir, "pet_test.sql"))
		require.NoError(t, err)
		// Run test
		err = Run(context.Background(), "pet", fsys)
		// Check error
		assert.ErrorContains(t, err, "already exists")
	})
}
