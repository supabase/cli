package serve

import (
	"context"
	"embed"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/cast"
)

var (
	//go:embed testdata/config.toml
	testConfig []byte
	//go:embed testdata/*
	testdata embed.FS
)

func TestServeCommand(t *testing.T) {
	t.Run("serves all functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, testConfig, 0644))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackEnvFilePath, []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte("{}"), 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		containerId := "supabase_edge_runtime_test"
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + containerId).
			Reply(http.StatusOK)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), containerId)
		require.NoError(t, apitest.MockDockerLogsStream(utils.Docker, containerId, 1, strings.NewReader("failed")))
		// Run test with timeout context
		err := Run(context.Background(), nil, "", nil, "", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "error running container: exit 1")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), nil, "", nil, "", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on missing db", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusNotFound)
		// Run test
		err := Run(context.Background(), nil, "", nil, "", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotRunning)
	})

	t.Run("throws error on missing env file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		// Run test
		err := Run(context.Background(), nil, ".env", nil, "", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "open .env: file does not exist")
	})

	t.Run("throws error on missing import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		require.NoError(t, afero.WriteFile(fsys, ".env", []byte{}, 0644))
		entrypoint := filepath.Join(utils.FunctionsDir, "hello", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, entrypoint, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		// Run test
		err := Run(context.Background(), nil, ".env", cast.Ptr(true), "import_map.json", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to resolve relative path:")
	})
}

func TestServeFunctions(t *testing.T) {
	require.NoError(t, utils.Config.Load("testdata/config.toml", testdata))
	utils.UpdateDockerIds()

	t.Run("runs inspect mode", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), utils.EdgeRuntimeId)
		// Run test
		err := ServeFunctions(context.Background(), nil, "", nil, "", "", RuntimeOption{
			InspectMode: cast.Ptr(InspectModeRun),
			InspectMain: true,
		}, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("parses env file", func(t *testing.T) {
		envPath := "/project/.env"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile(envPath, []byte(`
			DATABASE_URL=postgresql://localhost:5432/test
			API_KEY=secret123
			DEBUG=true
		`), fsys))
		// Run test
		env, err := parseEnvFile(envPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{
			"DATABASE_URL=postgresql://localhost:5432/test",
			"API_KEY=secret123",
			"DEBUG=true",
		}, env)
	})

	t.Run("parses function config for all functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test with nil slugs (serve all)
		binds, configString, err := PopulatePerFunctionConfigs(nil, "/", "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{
			"supabase_edge_runtime_test:/root/.cache/deno:rw",
			"/supabase/functions/:/supabase/functions/:ro",
		}, binds)
		// Should contain hello, good, bye but NOT world (disabled)
		assert.Contains(t, configString, `"hello"`)
		assert.Contains(t, configString, `"good"`)
		assert.Contains(t, configString, `"bye"`)
		assert.NotContains(t, configString, `"world"`)
	})

	t.Run("serves only disabled function returns empty config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test with only disabled function
		_, configString, err := PopulatePerFunctionConfigs([]string{"world"}, "/", "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		// Config should be empty since world is disabled
		assert.Equal(t, "{}", configString)
	})

	t.Run("serves single specific function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test with single slug
		_, configString, err := PopulatePerFunctionConfigs([]string{"hello"}, "/", "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		// Should only contain hello
		assert.Contains(t, configString, `"hello"`)
		assert.NotContains(t, configString, `"good"`)
		assert.NotContains(t, configString, `"bye"`)
		assert.NotContains(t, configString, `"world"`)
	})

	t.Run("serves multiple specific enabled functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test with multiple enabled slugs
		_, configString, err := PopulatePerFunctionConfigs([]string{"hello", "good", "bye"}, "/", "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		// Should contain all three
		assert.Contains(t, configString, `"hello"`)
		assert.Contains(t, configString, `"good"`)
		assert.Contains(t, configString, `"bye"`)
		assert.NotContains(t, configString, `"world"`)
	})

	t.Run("serves multiple functions skipping disabled ones", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test with mix of enabled and disabled slugs
		_, configString, err := PopulatePerFunctionConfigs([]string{"hello", "world", "good", "bye"}, "/", "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		// Should contain hello, good, bye but NOT world (disabled)
		assert.Contains(t, configString, `"hello"`)
		assert.Contains(t, configString, `"good"`)
		assert.Contains(t, configString, `"bye"`)
		assert.NotContains(t, configString, `"world"`)
	})
}
