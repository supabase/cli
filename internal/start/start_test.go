package start

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"regexp"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
	"github.com/supabase/cli/pkg/storage"
)

func TestStartCommand(t *testing.T) {
	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("show status if database is already running", func(t *testing.T) {
		var running []container.Summary
		for _, name := range utils.GetDockerIds() {
			running = append(running, container.Summary{
				Names: []string{name + "_test"},
			})
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})

		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_start/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON(running)
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.NoError(t, err)
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
			JSON(network.CreateResponse{})
		// Caches all dependencies
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Db.Image)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(image.InspectResponse{})
		for _, img := range config.Images.Services() {
			service := utils.GetRegistryImageUrl(img)
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/images/" + service + "/json").
				Reply(http.StatusOK).
				JSON(image.InspectResponse{})
		}
		// Start postgres
		utils.DbId = "test-postgres"
		utils.ConfigId = "test-config"
		utils.Config.Db.Port = 54322
		utils.Config.Db.MajorVersion = 15
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound)
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Start services
		utils.KongId = "test-kong"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Api.KongImage), utils.KongId)
		utils.GotrueId = "test-gotrue"
		utils.Config.Auth.EnableSignup = true
		utils.Config.Auth.Email.EnableSignup = true
		utils.Config.Auth.Email.DoubleConfirmChanges = true
		utils.Config.Auth.Email.EnableConfirmations = true
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), utils.GotrueId)
		utils.InbucketId = "test-inbucket"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Inbucket.Image), utils.InbucketId)
		utils.RealtimeId = "test-realtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), utils.RealtimeId)
		utils.RestId = "test-rest"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Api.Image), utils.RestId)
		utils.StorageId = "test-storage"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), utils.StorageId)
		utils.ImgProxyId = "test-imgproxy"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.ImgProxyImage), utils.ImgProxyId)
		utils.EdgeRuntimeId = "test-edge-runtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), utils.EdgeRuntimeId)
		utils.PgmetaId = "test-pgmeta"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage), utils.PgmetaId)
		utils.StudioId = "test-studio"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Studio.Image), utils.StudioId)
		utils.LogflareId = "test-logflare"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Analytics.Image), utils.LogflareId)
		utils.VectorId = "test-vector"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Analytics.VectorImage), utils.VectorId)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Setup health probes
		started := []string{
			utils.DbId, utils.KongId, utils.GotrueId, utils.InbucketId, utils.RealtimeId,
			utils.StorageId, utils.ImgProxyId, utils.EdgeRuntimeId, utils.PgmetaId, utils.StudioId,
			utils.LogflareId, utils.RestId, utils.VectorId,
		}
		for _, c := range started {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + c + "/json").
				Reply(http.StatusOK).
				JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: true,
						Health:  &container.Health{Status: types.Healthy},
					},
				}})
		}
		gock.New(utils.Config.Api.ExternalUrl).
			Head("/rest-admin/v1/ready").
			Reply(http.StatusOK)
		gock.New(utils.Config.Api.ExternalUrl).
			Head("/functions/v1/_internal/health").
			Reply(http.StatusOK)
		// Seed tenant services
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.StorageId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
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
			JSON(network.CreateResponse{})
		// Caches all dependencies
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Db.Image)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(image.InspectResponse{})
		// Start postgres
		utils.DbId = "test-postgres"
		utils.ConfigId = "test-config"
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
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
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

func TestFormatMapForEnvConfig(t *testing.T) {
	t.Run("It produces the correct format and removes the trailing comma", func(t *testing.T) {
		output := bytes.Buffer{}
		input := map[string]string{}

		keys := [4]string{"123456", "234567", "345678", "456789"}
		values := [4]string{"123456", "234567", "345678", "456789"}
		expected := [4]string{
			`^\w{6}:\w{6}$`,
			`^\w{6}:\w{6},\w{6}:\w{6}$`,
			`^\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6}$`,
			`^\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6}$`,
		}
		formatMapForEnvConfig(input, &output)
		if len(output.Bytes()) > 0 {
			t.Error("No values should be expected when empty map is provided")
		}
		for i := 0; i < 4; i++ {
			output.Reset()
			input[keys[i]] = values[i]
			formatMapForEnvConfig(input, &output)
			result := output.String()
			assert.Regexp(t, regexp.MustCompile(expected[i]), result)
		}
	})
}
