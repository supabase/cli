package test

import (
	"bytes"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTarDirectory(t *testing.T) {
	t.Run("tars a given directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		dir := "/tests"
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(dir, "order_test.pg"), []byte("SELECT 0;"), 0644))
		// Run test
		var buf bytes.Buffer
		assert.NoError(t, compress(dir, &buf, fsys))
	})
}
