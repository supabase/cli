package serve

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestServeCommand(t *testing.T) {
	t.Run("serves function locally", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK)
		utils.DenoRelayId = "test-deno"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DenoRelayImage), utils.DenoRelayId)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "test-func", "", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version http://localhost/v1.41/containers/supabase_deno_relay_serve/exec")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("serves all functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig("test", fsys))
		require.NoError(t, afero.WriteFile(fsys, ".env", []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		containerId := "supabase_deno_relay_test"
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.EdgeRuntimeImage), containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "success"))
		// Run test
		noVerifyJWT := true
		err := Run(context.Background(), "", ".env", &noVerifyJWT, "", fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), "", "", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "open supabase/config.toml: file does not exist")
	})

	t.Run("throws error on missing db", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig("test", fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), "", "", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "supabase start is not running.")
	})

	t.Run("throws error on missing env file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig("test", fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), "", ".env", nil, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "open .env: file does not exist")
	})

	t.Run("throws error on missing import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig("test", fsys))
		require.NoError(t, afero.WriteFile(fsys, ".env", []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), "", ".env", nil, "import_map.json", fsys)
		// Check error
		assert.ErrorContains(t, err, "open import_map.json: file does not exist")
	})
}
