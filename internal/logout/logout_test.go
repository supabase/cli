package logout

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func TestLogoutCommand(t *testing.T) {
	keyring.MockInit()

	t.Run("login with token and logout", func(t *testing.T) {
		token := string(apitest.RandomAccessToken(t))
		fs := afero.NewMemMapFs()
		assert.NoError(t, login.Run(context.Background(), os.Stdout, login.RunParams{
			Token: token,
			Fsys:  fs,
		}))
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, saved, token)

		// logout
		assert.NoError(t, Run(context.Background(), os.Stdout, RunParams{
			Fsys:          fs,
			DefaultAnswer: true,
		}))
		saved, err = credentials.Get(utils.AccessTokenKey)
		assert.Equal(t, keyring.ErrNotFound, err)
		assert.Equal(t, "", saved)
	})
}
