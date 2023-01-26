package status

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestStatusCommand(t *testing.T) {
	t.Run("shows service status", func(t *testing.T) {
		services := []string{
			"supabase_db_",
			"supabase_kong_",
			"supabase_auth_",
			"supabase_inbucket_",
			"realtime-dev.supabase_realtime_",
			"supabase_rest_",
			"supabase_storage_",
			"storage_imgproxy_",
			"supabase_pg_meta_",
			"supabase_studio_",
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		for _, container := range services {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + container).
				Reply(http.StatusOK).
				JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
					State: &types.ContainerState{Running: true},
				}})
		}
		// Run test
		assert.NoError(t, Run(context.Background(), CustomName{}, OutputPretty, fsys))
		// Check error
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		err := Run(context.Background(), CustomName{}, OutputPretty, afero.NewMemMapFs())
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), CustomName{}, OutputPretty, fsys)
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
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), CustomName{}, OutputPretty, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestServiceHealth(t *testing.T) {
	services := []string{"supabase_db", "supabase_auth"}

	t.Run("checks all services", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + services[0] + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{
					Running: true,
					Health:  &types.Health{Status: "Unhealthy"},
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + services[1] + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Status: "exited"},
			}})
		// Run test
		var stderr bytes.Buffer
		stopped := checkServiceHealth(context.Background(), services, &stderr)
		// Check error
		assert.Empty(t, stopped)
		lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
		assert.ElementsMatch(t, []string{
			"supabase_db container is not ready: Unhealthy",
			"supabase_auth container is not running: exited",
		}, lines)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing container", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		for _, name := range services {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + name + "/json").
				Reply(http.StatusNotFound)
		}
		// Run test
		stopped := checkServiceHealth(context.Background(), services, io.Discard)
		// Check error
		assert.ElementsMatch(t, services, stopped)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPrintStatus(t *testing.T) {
	utils.Config.Db.Port = 0
	exclude := []string{
		utils.ShortContainerImageName(utils.PostgrestImage),
		utils.ShortContainerImageName(utils.StudioImage),
		utils.GotrueId,
		utils.InbucketId,
	}

	t.Run("outputs env var", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, OutputEnv, &stdout, exclude...))
		// Check error
		assert.Equal(t, "DB_URL=\"postgresql://postgres:postgres@localhost:0/postgres\"\n", stdout.String())
	})

	t.Run("outputs json object", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, OutputJson, &stdout, exclude...))
		// Check error
		assert.Equal(t, "{\"DB_URL\":\"postgresql://postgres:postgres@localhost:0/postgres\"}\n", stdout.String())
	})

	t.Run("outputs yaml properties", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, OutputYaml, &stdout, exclude...))
		// Check error
		assert.Equal(t, "DB_URL: postgresql://postgres:postgres@localhost:0/postgres\n", stdout.String())
	})

	t.Run("outputs toml fields", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, OutputToml, &stdout, exclude...))
		// Check error
		assert.Equal(t, "DB_URL = \"postgresql://postgres:postgres@localhost:0/postgres\"\n", stdout.String())
	})
}
