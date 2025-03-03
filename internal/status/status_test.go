package status

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestStatusCommand(t *testing.T) {
	t.Run("shows service status", func(t *testing.T) {
		var running []container.Summary
		for _, name := range utils.GetDockerIds() {
			running = append(running, container.Summary{
				Names: []string{name + "_test"},
			})
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
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
		assert.NoError(t, Run(context.Background(), CustomName{}, utils.OutputPretty, fsys))
		// Check error
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), CustomName{}, utils.OutputPretty, fsys)
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
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), CustomName{}, utils.OutputPretty, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestServiceHealth(t *testing.T) {
	t.Run("checks all services", func(t *testing.T) {
		var running []container.Summary
		for _, name := range utils.GetDockerIds() {
			running = append(running, container.Summary{
				Names: []string{"/" + name},
			})
		}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON(running)
		// Run test
		stopped, err := checkServiceHealth(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, stopped)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("shows stopped container", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Reply(http.StatusOK).
			JSON([]container.Summary{})
		// Run test
		stopped, err := checkServiceHealth(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, utils.GetDockerIds(), stopped)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			ReplyError(errNetwork)
		// Run test
		stopped, err := checkServiceHealth(context.Background())
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, stopped)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestPrintStatus(t *testing.T) {
	utils.Config.Db.Port = 0
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Api.Enabled = false
	utils.Config.Auth.Enabled = false
	utils.Config.Storage.Enabled = false
	utils.Config.Realtime.Enabled = false
	utils.Config.Studio.Enabled = false
	utils.Config.Analytics.Enabled = false
	utils.Config.Inbucket.Enabled = false

	t.Run("outputs env var", func(t *testing.T) {
		utils.Config.Hostname = "127.0.0.1"
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, utils.OutputEnv, &stdout))
		// Check error
		assert.Equal(t, "DB_URL=\"postgresql://postgres:postgres@127.0.0.1:0/postgres\"\n", stdout.String())
	})

	t.Run("outputs json object", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, utils.OutputJson, &stdout))
		// Check error
		assert.Equal(t, "{\n  \"DB_URL\": \"postgresql://postgres:postgres@127.0.0.1:0/postgres\"\n}\n", stdout.String())
	})

	t.Run("outputs yaml properties", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, utils.OutputYaml, &stdout))
		// Check error
		assert.Equal(t, "DB_URL: postgresql://postgres:postgres@127.0.0.1:0/postgres\n", stdout.String())
	})

	t.Run("outputs toml fields", func(t *testing.T) {
		// Run test
		var stdout bytes.Buffer
		assert.NoError(t, printStatus(CustomName{DbURL: "DB_URL"}, utils.OutputToml, &stdout))
		// Check error
		assert.Equal(t, "DB_URL = \"postgresql://postgres:postgres@127.0.0.1:0/postgres\"\n", stdout.String())
	})
}
