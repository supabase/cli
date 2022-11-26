package status

import (
	"bytes"
	"context"
	"errors"
	"io"
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

func TestStatusCommand(t *testing.T) {
	t.Run("shows service status", func(t *testing.T) {
		services := []string{
			"supabase_db_",
			"supabase_kong_",
			"supabase_auth_",
			"supabase_inbucket_",
			"realtime-demo.supabase_realtime_",
			"supabase_rest_",
			"supabase_storage_",
			"supabase_pg_meta_",
			"supabase_studio_",
		}
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
		assert.ErrorContains(t, err, "Have you set up the project with supabase init?")
	})

	t.Run("throws error on invalid config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), CustomName{}, OutputPretty, fsys)
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
			Reply(http.StatusServiceUnavailable)
		gock.New(utils.Docker.DaemonHost()).
			Get("/_ping").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), CustomName{}, OutputPretty, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing container", func(t *testing.T) {
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
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), CustomName{}, OutputPretty, fsys)
		// Check error
		assert.ErrorContains(t, err, "container not found. Have your run supabase start?")
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
				State: &types.ContainerState{Running: true},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + services[1] + "/json").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
				State: &types.ContainerState{Status: "exited"},
			}})
		// Run test
		var stderr bytes.Buffer
		assert.NoError(t, checkServiceHealth(context.Background(), services, &stderr))
		// Check error
		assert.Equal(t, "supabase_auth container is not running: exited\n", stderr.String())
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing container", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + services[0] + "/json").
			Reply(http.StatusNotFound)
		// Run test
		err := checkServiceHealth(context.Background(), services, io.Discard)
		// Check error
		assert.ErrorContains(t, err, "supabase_db container not found. Have your run supabase start?")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPrintStatus(t *testing.T) {
	t.Run("outputs env var", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(map[string]string{"2": "b", "1": "a"}, OutputEnv, &stdout))
		// Check error
		assert.Equal(t, "1=\"a\"\n2=\"b\"\n", stdout.String())
	})

	t.Run("outputs json object", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(map[string]string{"2": "b", "1": "a"}, OutputJson, &stdout))
		// Check error
		assert.Equal(t, "{\"1\":\"a\",\"2\":\"b\"}\n", stdout.String())
	})

	t.Run("outputs yaml properties", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(map[string]string{"2": "b", "1": "a"}, OutputYaml, &stdout))
		// Check error
		assert.Equal(t, "\"1\": a\n\"2\": b\n", stdout.String())
	})

	t.Run("outputs toml fields", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(map[string]string{"2": "b", "1": "a"}, OutputToml, &stdout))
		// Check error
		assert.Equal(t, "1 = \"a\"\n2 = \"b\"\n", stdout.String())
	})
}
