package start

import (
	"context"
	"errors"
	"net/http"
	"os"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/volume"
	"github.com/jackc/pgconn"
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
		err := Run(context.Background(), afero.NewMemMapFs(), []string{}, false, "", "")
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), fsys, []string{}, false, "", "")
		// Check error
		assert.ErrorContains(t, err, "toml: line 0: unexpected EOF; expected key separator '='")
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
		err := Run(context.Background(), fsys, []string{}, false, "", "")
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("noop if database is already running", func(t *testing.T) {
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
		err := Run(context.Background(), fsys, []string{}, false, "", "")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on image pull failure", func(t *testing.T) {
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
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			ReplyError(errors.New("network error"))
		// Cleans up network on error
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/networks/supabase_network_").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), fsys, []string{}, false, "", "")
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDatabaseStart(t *testing.T) {
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
		utils.DbImage = utils.Pg15Image
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
		utils.Config.Db.MajorVersion = 15
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound)
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.GotrueImage), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StorageImage), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
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
		utils.ImgProxyId = "test-imgproxy"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.ImageProxyImage), utils.ImgProxyId)
		utils.DifferId = "test-differ"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.DifferImage), utils.DifferId)
		utils.DenoRelayId = "test-edge-runtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.EdgeRuntimeImage), utils.DenoRelayId)
		utils.PgmetaId = "test-pgmeta"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.PgmetaImage), utils.PgmetaId)
		utils.StudioId = "test-studio"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.StudioImage), utils.StudioId)
		utils.LogflareId = "test-logflare"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.LogflareImage), utils.LogflareId)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Setup health probes
		started := []string{
			utils.DbId, utils.KongId, utils.GotrueId, utils.InbucketId, utils.RealtimeId,
			utils.StorageId, utils.ImgProxyId, utils.DenoRelayId, utils.PgmetaId, utils.StudioId,
			utils.LogflareId, utils.RestId,
		}
		for _, container := range started {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + container + "/json").
				Reply(http.StatusOK).
				JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
					State: &types.ContainerState{
						Running: true,
						Health:  &types.Health{Status: "healthy"},
					},
				}})
		}
		gock.New("localhost").
			Head("/rest/v1/").
			Reply(http.StatusOK)
		gock.New("localhost").
			Head("/functions/v1/_internal/health").
			Reply(http.StatusOK)
		// Run test
		err := utils.RunProgram(context.Background(), func(p utils.Program, ctx context.Context) error {
			return run(p, context.Background(), fsys, []string{}, pgconn.Config{Host: utils.DbId}, conn.Intercept)
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips excluded containers", func(t *testing.T) {
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
		utils.DbImage = utils.Pg15Image
		imageUrl := utils.GetRegistryImageUrl(utils.DbImage)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(types.ImageInspect{})
		// Start postgres
		utils.DbId = "test-postgres"
		utils.Config.Db.Port = 54322
		utils.Config.Db.MajorVersion = 15
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(volume.Volume{})
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "healthy"},
				},
			}})
		// Run test
		exclude := ExcludableContainers()
		exclude = append(exclude, "invalid", exclude[0])
		err := utils.RunProgram(context.Background(), func(p utils.Program, ctx context.Context) error {
			return run(p, context.Background(), fsys, exclude, pgconn.Config{Host: utils.DbId})
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
