package new

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestNewCommand(t *testing.T) {
	t.Run("creates new migration file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup empty stdin
		stdin, err := fsys.Create("/dev/stdin")
		require.NoError(t, err)
		// Run test
		assert.NoError(t, Run("test_migrate", stdin, fsys))
		// Validate output
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.Equal(t, 1, len(files))
		assert.Regexp(t, `([0-9]{14})_test_migrate\.sql`, files[0].Name())
	})

	t.Run("streams content from pipe", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup stdin
		r, w, err := os.Pipe()
		require.NoError(t, err)
		script := "create table pet;\ndrop table pet;\n"
		_, err = w.WriteString(script)
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Run test
		assert.NoError(t, Run("test_migrate", r, fsys))
		// Validate output
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.Equal(t, 1, len(files))
		path := filepath.Join(utils.MigrationsDir, files[0].Name())
		contents, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, []byte(script), contents)
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewMemMapFs()
		// Setup empty stdin
		stdin, err := fsys.Create("/dev/stdin")
		require.NoError(t, err)
		// Run test
		assert.Error(t, Run("test_migrate", stdin, afero.NewReadOnlyFs(fsys)))
	})

	t.Run("throws error on closed pipe", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewMemMapFs()
		// Setup empty stdin
		r, _, err := os.Pipe()
		require.NoError(t, err)
		require.NoError(t, r.Close())
		// Run test
		assert.Error(t, Run("test_migrate", r, fsys))
	})
}
