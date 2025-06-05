package serve

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/cast"
)

func TestServeCommand(t *testing.T) {
	t.Run("serves all functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackEnvFilePath, []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		containerId := "supabase_edge_runtime_test"
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "success"))

		// Create a context with timeout to prevent test from hanging
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Create mock file watcher setup that doesn't watch any files
		mockWatcherSetup := &MockFileWatcherSetup{
			MockWatcher: nil, // No watcher needed for this test
			MockPath:    "",  // No path needed
			MockError:   nil, // No error
		}

		// Run test with timeout context and mock watcher
		err := RunWithWatcher(ctx, "", nil, "", RuntimeOption{}, fsys, mockWatcherSetup)
		// Check error - expect context.DeadlineExceeded because the server runs until cancelled
		assert.ErrorIs(t, err, context.DeadlineExceeded)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))

		// Create mock file watcher setup
		mockWatcherSetup := &MockFileWatcherSetup{
			MockWatcher: nil,
			MockPath:    "",
			MockError:   nil,
		}

		// Run test
		err := RunWithWatcher(context.Background(), "", nil, "", RuntimeOption{}, fsys, mockWatcherSetup)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on missing db", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusNotFound)

		// Create mock file watcher setup
		mockWatcherSetup := &MockFileWatcherSetup{
			MockWatcher: nil,
			MockPath:    "",
			MockError:   nil,
		}

		// Run test
		err := RunWithWatcher(context.Background(), "", nil, "", RuntimeOption{}, fsys, mockWatcherSetup)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotRunning)
	})

	t.Run("throws error on missing env file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})

		// Create mock file watcher setup
		mockWatcherSetup := &MockFileWatcherSetup{
			MockWatcher: nil,
			MockPath:    "",
			MockError:   nil,
		}

		// Run test
		err := RunWithWatcher(context.Background(), ".env", nil, "", RuntimeOption{}, fsys, mockWatcherSetup)
		// Check error
		assert.ErrorContains(t, err, "open .env: file does not exist")
	})

	t.Run("throws error on missing import map", func(t *testing.T) {
		utils.CurrentDirAbs = "/"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		require.NoError(t, afero.WriteFile(fsys, ".env", []byte{}, 0644))
		entrypoint := filepath.Join(utils.FunctionsDir, "hello", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, entrypoint, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})

		// Create mock file watcher setup
		mockWatcherSetup := &MockFileWatcherSetup{
			MockWatcher: nil,
			MockPath:    "",
			MockError:   nil,
		}

		// Run test
		err := RunWithWatcher(context.Background(), ".env", cast.Ptr(true), "import_map.json", RuntimeOption{}, fsys, mockWatcherSetup)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
