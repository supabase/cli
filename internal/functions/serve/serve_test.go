package serve

import (
	"context"
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
		err := Run(context.Background(), "test-func", "", true, "", "", fsys)
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version http://localhost/v1.41/containers/supabase_deno_relay_serve/exec")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
