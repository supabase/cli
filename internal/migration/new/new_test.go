package new

import (
	"bytes"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
)

func TestNewCommand(t *testing.T) {
	t.Run("creates new migration file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup empty stdin
		stdin := &bytes.Buffer{}
		// Run test
		assert.NoError(t, Run("test_migrate", stdin, fsys))
		// Validate output
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		match, err := regexp.MatchString(`([0-9]{14})_test_migrate\.sql`, files[0].Name())
		assert.NoError(t, err)
		assert.True(t, match)
	})

	t.Run("creates new file with contents", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup stdin
		script := "create table pet;\ndrop table pet;\n"
		// Run test
		assert.NoError(t, Run("test_migrate", bytes.NewBufferString(script), fsys))
		// Validate output
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		path := filepath.Join(utils.MigrationsDir, files[0].Name())
		contents, err := afero.ReadFile(fsys, path)
		assert.NoError(t, err)
		assert.Equal(t, script, contents)
	})

	t.Run("throws error on failure to create directory", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup empty stdin
		stdin := &bytes.Buffer{}
		// Run test
		assert.Error(t, Run("test_migrate", stdin, fsys))
	})
}
