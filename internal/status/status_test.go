package status

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
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
			Persist().
			Reply(http.StatusOK).
			JSON(running)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/networks").
			Reply(http.StatusOK).
			JSON([]network.Summary{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes").
			Reply(http.StatusOK).
			JSON(volume.ListResponse{})
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

func TestBuildRuntimeItems(t *testing.T) {
	originalContainers := listProjectContainers
	originalNetworks := listProjectNetworks
	originalVolumes := listProjectVolumes
	t.Cleanup(func() {
		listProjectContainers = originalContainers
		listProjectNetworks = originalNetworks
		listProjectVolumes = originalVolumes
	})
	utils.Config.Local.Runtime = config.AppleContainerRuntime
	utils.Config.ProjectId = "demo"
	utils.Config.Db.Port = 54322
	utils.Config.Api.Enabled = true
	utils.Config.Api.Port = 54321
	utils.Config.Studio.Enabled = true
	utils.Config.Studio.Port = 54323
	utils.Config.Inbucket.Enabled = true
	utils.Config.Inbucket.Port = 54324
	listProjectContainers = func(_ context.Context, projectId string, all bool) ([]utils.ContainerInfo, error) {
		assert.Equal(t, "demo", projectId)
		assert.True(t, all)
		return []utils.ContainerInfo{{ID: "supabase-db-demo"}, {ID: "supabase-kong-demo"}}, nil
	}
	listProjectNetworks = func(_ context.Context, projectId string) ([]utils.NetworkInfo, error) {
		assert.Equal(t, "demo", projectId)
		return []utils.NetworkInfo{{Name: "supabase-network-demo"}}, nil
	}
	listProjectVolumes = func(_ context.Context, projectId string) ([]utils.VolumeInfo, error) {
		assert.Equal(t, "demo", projectId)
		return []utils.VolumeInfo{{Name: "supabase-db-demo"}}, nil
	}

	items, err := buildRuntimeItems(context.Background())

	require.NoError(t, err)
	assert.Contains(t, items, OutputItem{Label: "Runtime", Value: "apple-container", Type: Text})
	assert.Contains(t, items, OutputItem{Label: "Project", Value: "demo", Type: Text})
	assert.Contains(t, items, OutputItem{Label: "Networks", Value: "supabase-network-demo", Type: Text})
	assert.Contains(t, items, OutputItem{Label: "Volumes", Value: "supabase-db-demo", Type: Text})
}

func TestPrettyPrintIncludesRuntimeResources(t *testing.T) {
	originalContainers := listProjectContainers
	originalNetworks := listProjectNetworks
	originalVolumes := listProjectVolumes
	t.Cleanup(func() {
		listProjectContainers = originalContainers
		listProjectNetworks = originalNetworks
		listProjectVolumes = originalVolumes
	})
	utils.Config.Local.Runtime = config.AppleContainerRuntime
	utils.Config.ProjectId = "demo"
	utils.Config.Db.Port = 54322
	utils.Config.Api.Enabled = false
	utils.Config.Auth.Enabled = false
	utils.Config.Storage.Enabled = false
	utils.Config.Realtime.Enabled = false
	utils.Config.Studio.Enabled = false
	utils.Config.Analytics.Enabled = false
	utils.Config.Inbucket.Enabled = false
	listProjectContainers = func(_ context.Context, _ string, _ bool) ([]utils.ContainerInfo, error) {
		return []utils.ContainerInfo{{ID: "supabase-db-demo"}}, nil
	}
	listProjectNetworks = func(_ context.Context, _ string) ([]utils.NetworkInfo, error) {
		return []utils.NetworkInfo{{Name: "supabase-network-demo"}}, nil
	}
	listProjectVolumes = func(_ context.Context, _ string) ([]utils.VolumeInfo, error) {
		return []utils.VolumeInfo{{Name: "supabase-db-demo"}}, nil
	}

	var stdout bytes.Buffer
	PrettyPrint(context.Background(), &stdout)

	out := stdout.String()
	assert.True(t, strings.Contains(out, "Runtime"))
	assert.True(t, strings.Contains(out, "apple-container"))
	assert.True(t, strings.Contains(out, "supabase-network-demo"))
	assert.True(t, strings.Contains(out, "supabase-db-demo"))
}
