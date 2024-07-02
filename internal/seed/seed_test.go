package seed

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestSeedCommand(t *testing.T) {
	t.Run("throws error on missing config", func(t *testing.T) {
		err := Run(context.Background(), afero.NewOsFs())
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("generate seed data for auth schema", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		// Set up mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		// mocks for creating the shadow db
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg15Image), "test-shadow-db")
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-db/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})

		// mocks for creating the shadow auth container
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), "test-shadow-auth")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/test-shadow-auth/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})

		// mock admin requests to auth
		req := gock.New("http://localhost:54325").Post("/admin/users").Reply(http.StatusOK).JSON(UserResponse{
			Id:    "ab8e2e95-cf43-429e-9dab-a241778e3d64",
			Email: "test@example.com",
		})
		req.Mock.Request().Counter = numberOfTestUsersCreated

		// mocks for dumping the shadow db
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Pg15Image), "test-shadow-db")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-shadow-db", ""))

		err := Run(context.Background(), fsys)
		assert.NoError(t, err)

		// check seed example file generated
		hasFile, err := afero.Exists(fsys, utils.SeedExampleDataPath)
		assert.NoError(t, err)
		assert.True(t, hasFile)
	})
}
