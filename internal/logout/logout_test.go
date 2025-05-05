package logout

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func TestLogoutCommand(t *testing.T) {
	token := string(apitest.RandomAccessToken(t))

	t.Run("login with token and logout", func(t *testing.T) {
		keyring.MockInitWithError(keyring.ErrUnsupportedPlatform)
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.SaveAccessToken(token, fsys))
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.NoError(t, err)
		saved, err := utils.LoadAccessTokenFS(fsys)
		assert.ErrorIs(t, err, utils.ErrMissingToken)
		assert.Empty(t, saved)
	})

	t.Run("removes all Supabase CLI credentials", func(t *testing.T) {
		keyring.MockInit()
		require.NoError(t, credentials.StoreProvider.Set(utils.AccessTokenKey, token))
		require.NoError(t, credentials.StoreProvider.Set("project1", "password1"))
		require.NoError(t, credentials.StoreProvider.Set("project2", "password2"))
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Run test
		err := Run(context.Background(), os.Stdout, afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
		// Check that access token has been removed
		saved, _ := credentials.StoreProvider.Get(utils.AccessTokenKey)
		assert.Empty(t, saved)
		// check that project 1 has been removed
		saved, _ = credentials.StoreProvider.Get("project1")
		assert.Empty(t, saved)
		// check that project 2 has been removed
		saved, _ = credentials.StoreProvider.Get("project2")
		assert.Empty(t, saved)
	})

	t.Run("skips logout by default", func(t *testing.T) {
		keyring.MockInit()
		require.NoError(t, credentials.StoreProvider.Set(utils.AccessTokenKey, token))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
		saved, err := credentials.StoreProvider.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
	})

	t.Run("exits 0 if not logged in", func(t *testing.T) {
		keyring.MockInit()
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on failure to delete", func(t *testing.T) {
		keyring.MockInitWithError(keyring.ErrNotFound)
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup empty home directory
		t.Setenv("HOME", "")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.ErrorContains(t, err, "$HOME is not defined")
	})
}
