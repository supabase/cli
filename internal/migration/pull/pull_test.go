package pull

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

const (
	username = "admin"
	password = "password"
	database = "postgres"
	host     = "localhost"
)

func TestPullCommand(t *testing.T) {
	imageUrl := utils.GetRegistryImageUrl(utils.Pg14Image)
	const containerId = "test-container"

	t.Run("pulls from remote", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), username, password, database, host, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Validate migration
		files, err := afero.ReadDir(fsys, utils.MigrationsDir)
		assert.NoError(t, err)
		assert.Equal(t, 1, len(files))
		assert.Regexp(t, `([0-9]{14})_remote_commit\.sql`, files[0].Name())
		contents, err := afero.ReadFile(fsys, filepath.Join(utils.MigrationsDir, files[0].Name()))
		assert.NoError(t, err)
		assert.Equal(t, []byte("hello world"), contents)
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), username, password, database, host, fsys)
		// Check error
		assert.ErrorContains(t, err, "Error running pg_dump on remote database: request returned Service Unavailable")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), username, password, database, host, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := &MockFs{DenyPath: utils.MigrationsDir}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		err := Run(context.Background(), username, password, database, host, fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

type MockFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *MockFs) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.OpenFile(name, flag, perm)
}
