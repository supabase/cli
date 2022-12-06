package start

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
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestStartCommand(t *testing.T) {
	t.Run("throws error on missing config", func(t *testing.T) {
		err := Run(context.Background(), afero.NewMemMapFs(), []string{})
		assert.ErrorContains(t, err, "Have you set up the project with supabase init?")
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), fsys, []string{})
		// Check error
		assert.ErrorContains(t, err, "Failed to read config: toml")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Head("/_ping").
			ReplyError(errors.New("network error"))
		gock.New(utils.Docker.DaemonHost()).
			Get("/_ping").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys, []string{})
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on running database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New("http:///var/run/docker.sock").
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), fsys, []string{})
		// Check error
		assert.ErrorContains(t, err, "supabase start is already running. Try running supabase stop first.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to create network", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Head("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/_ping").
			Reply(http.StatusOK).
			SetHeader("API-Version", utils.Docker.ClientVersion()).
			SetHeader("OSType", "linux")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusNotFound)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/create").
			ReplyError(errors.New("network error"))
		// Cleans up network on error
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/networks/supabase_network_").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), fsys, []string{})
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPullImage(t *testing.T) {
	const image = "postgres"
	imageUrl := utils.GetRegistryImageUrl(image)
	p := utils.NewProgram(model{})

	t.Run("inspects image before pull", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		err := pullImage(p, context.Background(), image)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("pulls missing image", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusNotFound)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v"+utils.Docker.ClientVersion()+"/images/create").
			MatchParam("fromImage", image).
			MatchParam("tag", "latest").
			Reply(http.StatusAccepted).
			BodyString("progress")
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Run test
		err := pullImage(p, context.Background(), image)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	// TODO: test for transient error
}

func TestDatabaseStart(t *testing.T) {
	p := utils.NewProgram(model{})

	t.Run("starts database locally", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(types.NetworkCreateResponse{})
		// Caches all dependencies
		utils.DbImage = utils.Pg14Image
		imageUrl := utils.GetRegistryImageUrl(utils.DbImage)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		for _, image := range utils.ServiceImages {
			service := utils.GetRegistryImageUrl(image)
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/images/" + service + "/json").
				Reply(http.StatusOK).
				JSON(types.ImageInspect{})
		}
		// Start postgres
		utils.DbId = "test-postgres"
		utils.Config.Db.Port = 54322
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Health: &types.Health{Status: "healthy"}},
			}})
		// Start services
		utils.KongId = "test-kong"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.KongImage), utils.KongId)
		utils.GotrueId = "test-gotrue"
		flag := true
		utils.Config.Auth.EnableSignup = &flag
		utils.Config.Auth.Email.EnableSignup = &flag
		utils.Config.Auth.Email.DoubleConfirmChanges = &flag
		utils.Config.Auth.Email.EnableConfirmations = &flag
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), utils.GotrueId)
		utils.InbucketId = "test-inbucket"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.InbucketImage), utils.InbucketId)
		utils.RealtimeId = "test-realtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.RealtimeImage), utils.RealtimeId)
		utils.RestId = "test-rest"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.PostgrestImage), utils.RestId)
		utils.StorageId = "test-storage"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StorageImage), utils.StorageId)
		utils.DifferId = "test-differ"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DifferImage), utils.DifferId)
		utils.PgmetaId = "test-pgmeta"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.PgmetaImage), utils.PgmetaId)
		utils.StudioId = "test-studio"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StudioImage), utils.StudioId)
		// Setup mock postgres
		utils.GlobalsSql = "create schema public"
		utils.InitialSchemaSql = "create schema private"
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(utils.GlobalsSql).
			Reply("CREATE SCHEMA").
			Query(utils.InitialSchemaSql).
			Reply("CREATE SCHEMA")
		// Run test
		err := run(p, context.Background(), fsys, []string{}, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
