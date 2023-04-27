package login

import (
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

func TestLoginCommand(t *testing.T) {
	keyring.MockInit()

	t.Run("prompts and validates api token", func(t *testing.T) {
		token := apitest.RandomAccessToken(t)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup stdin with random token
		r, w, err := os.Pipe()
		require.NoError(t, err)
		_, err = w.Write(token)
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Run test
		assert.NoError(t, Run(r, fsys))
		// Validate saved token
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, string(token), saved)
	})
}
