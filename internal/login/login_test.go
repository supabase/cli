package login

import (
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestLoginCommand(t *testing.T) {
	t.Run("throws error on invalid token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup malformed token
		r, w, err := os.Pipe()
		require.NoError(t, err)
		// Value does not matter as term.ReadPassword always returns empty
		_, err = w.WriteString("malformed")
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Run test
		err = Run(r, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrInvalidToken)
	})
}
