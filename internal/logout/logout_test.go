package logout

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func TestLogoutCommand(t *testing.T) {
	keyring.MockInit()
	token := string(apitest.RandomAccessToken(t))

	t.Run("login with token and logout", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, login.Run(context.Background(), os.Stdout, login.RunParams{
			Token: token,
			Fsys:  fsys,
		}))
		// Run test
		err := Run(context.Background(), os.Stdout, RunParams{
			Fsys:          fsys,
			DefaultAnswer: true,
		})
		// Check error
		assert.NoError(t, err)
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.ErrorIs(t, err, keyring.ErrNotFound)
		assert.Empty(t, saved)
	})

	t.Run("skips logout by default", func(t *testing.T) {
		require.NoError(t, credentials.Set(utils.AccessTokenKey, token))
		defer func() {
			_ = credentials.Delete(utils.AccessTokenKey)
		}()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, RunParams{Fsys: fsys})
		// Check error
		assert.NoError(t, err)
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
	})

	t.Run("exits 0 if not logged in", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, RunParams{
			Fsys:          fsys,
			DefaultAnswer: true,
		})
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on failure to delete", func(t *testing.T) {
		// Setup empty home directory
		t.Setenv("HOME", "")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, RunParams{
			Fsys:          fsys,
			DefaultAnswer: true,
		})
		// Check error
		assert.ErrorContains(t, err, "$HOME is not defined")
	})
}
