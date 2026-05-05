package unlink

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func TestUnlinkCommand(t *testing.T) {
	keyring.MockInit()
	project := apitest.RandomProjectRef()

	t.Run("unlinks project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Save database password
		require.NoError(t, credentials.StoreProvider.Set(project, "test"))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
		// Validate file does not exist
		exists, err := afero.Exists(fsys, utils.ProjectRefPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		// Check credentials does not exist
		_, err = credentials.StoreProvider.Get(project)
		assert.ErrorIs(t, err, keyring.ErrNotFound)
	})

	t.Run("unlinks project without credentials", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error if not linked", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Run test
		err := Run(context.Background(), afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}
