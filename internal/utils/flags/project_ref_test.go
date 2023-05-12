package flags

import (
	"bufio"
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
)

func TestProjectRef(t *testing.T) {
	t.Run("validates cmd flag", func(t *testing.T) {
		ProjectRef = "invalid"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := ParseProjectRef(fsys)
		// Check error
		assert.Error(t, err, utils.ErrInvalidRef)
	})

	t.Run("loads from linked", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err := afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Run test
		err = ParseProjectRef(fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.ProjectRefPath}
		// Run test
		err := ParseProjectRef(fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error if all fail", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := ParseProjectRef(fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})
}

func TestProjectPrompt(t *testing.T) {
	t.Run("validates prompt input", func(t *testing.T) {
		var stdin bytes.Buffer
		_, err := stdin.WriteString(apitest.RandomProjectRef())
		require.NoError(t, err)
		// Run test
		err = promptProjectRef(&stdin)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		// Setup long token
		var stdin bytes.Buffer
		_, err := stdin.WriteString(strings.Repeat("a", bufio.MaxScanTokenSize))
		require.NoError(t, err)
		// Run test
		err = promptProjectRef(&stdin)
		// Check error
		assert.ErrorIs(t, err, bufio.ErrTooLong)
	})
}
