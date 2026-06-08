package start

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestStartStripeSyncEngine(t *testing.T) {
	t.Run("noop when disabled", func(t *testing.T) {
		utils.Config.StripeSync.Enabled = false
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Run test
		err := StartStripeSyncEngine(context.Background(), io.Discard)
		// Check error
		assert.NoError(t, err)
		// No docker interaction expected when disabled
		assert.False(t, gock.HasUnmatchedRequest())
	})

	t.Run("recreates container and waits for healthy", func(t *testing.T) {
		utils.StripeSyncEngineId = "test-stripe"
		utils.NetId = "test-network"
		utils.DbId = "test-db"
		utils.Config.StripeSync.Enabled = true
		utils.Config.StripeSync.Image = "supabase/stripe-sync-engine:test"
		utils.Config.StripeSync.Port = 54328
		utils.Config.StripeSync.Schema = "stripe"
		t.Cleanup(func() { utils.Config.StripeSync.Enabled = false })
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Removes any container left over from a previous run so a reset re-runs
		// the engine's migrations against the freshly recreated database.
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.StripeSyncEngineId).
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.StripeSync.Image), utils.StripeSyncEngineId)
		// Reports healthy on the first probe
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.StripeSyncEngineId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		// Run test
		err := StartStripeSyncEngine(context.Background(), io.Discard)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
