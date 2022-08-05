package delete

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestBranchDir(t *testing.T) {
	t.Run("removes a branch directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(filepath.Dir(utils.CurrBranchPath), "test-branch")
		require.NoError(t, fsys.Mkdir(path, 0755))
		// Run test
		assert.NoError(t, deleteBranchDir("test-branch", fsys))
		// Validate removal
		exists, err := afero.Exists(fsys, path)
		assert.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("branch is current", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.CurrBranchPath, []byte("main"), 0644))
		// Run test
		assert.Error(t, deleteBranchDir("main", fsys))
	})

	t.Run("branch is reserved", func(t *testing.T) {
		assert.Error(t, deleteBranchDir("main", afero.NewMemMapFs()))
	})

	t.Run("branch does not exist", func(t *testing.T) {
		assert.Error(t, deleteBranchDir("test-branch", afero.NewMemMapFs()))
	})

	t.Run("branch permission denied", func(t *testing.T) {
		// Setup read-only fs
		fsys := afero.NewMemMapFs()
		path := filepath.Join(filepath.Dir(utils.CurrBranchPath), "test-branch")
		require.NoError(t, fsys.Mkdir(path, 0755))
		// Run test
		assert.Error(t, deleteBranchDir("test-branch", afero.NewReadOnlyFs(fsys)))
	})
}

func TestDeleteCommand(t *testing.T) {
	const (
		version = "v1.41"
		branch  = "test-branch"
	)

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(branch, afero.NewMemMapFs()))
	})

	t.Run("throws error on stopped db", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &afero.MemMapFs{}
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		defer gock.Off()
		gock.InterceptClient(utils.Docker.HTTPClient())
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", version).
			SetHeader("OSType", "linux")
		// Run test
		assert.Error(t, Run(branch, fsys))
	})
}
