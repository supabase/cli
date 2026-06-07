package deploy

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
)

func TestDeployCommand(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	const slug = "test-func"
	const containerId = "test-container"
	imageUrl := utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image)

	parsed, err := url.Parse(utils.Docker.DaemonHost())
	require.NoError(t, err)
	parsed.Scheme = "http:"
	dockerHost := parsed.String()

	t.Run("deploys multiple functions", func(t *testing.T) {
		functions := []string{slug, slug + "-2"}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		for i := range functions {
			// Do not match slug to avoid flakey tests
			gock.New(utils.DefaultApiHost).
				Post("/v1/projects/" + flags.ProjectRef + "/functions").
				Reply(http.StatusCreated).
				JSON(api.FunctionResponse{Id: fmt.Sprintf("%d", i)})
			// Setup mock docker
			require.NoError(t, apitest.MockDocker(utils.Docker))
			apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
			require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		}
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON(api.BulkUpdateFunctionResponse{})
		// Setup output file
		for _, v := range functions {
			outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", v))
			require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		}
		// Run test
		noVerifyJWT := true
		err = Run(context.Background(), functions, true, &noVerifyJWT, "", 1, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("deploys functions from config", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile(utils.ConfigPath, os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
import_map = "./import_map.json"
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		importMapPath := filepath.Join(utils.SupabaseDirPath, "import_map.json")
		require.NoError(t, afero.WriteFile(fsys, importMapPath, []byte("{}"), 0644))
		// Setup function entrypoint
		entrypointPath := filepath.Join(utils.FunctionsDir, slug, "index.ts")
		require.NoError(t, afero.WriteFile(fsys, entrypointPath, []byte{}, 0644))
		ignorePath := filepath.Join(utils.FunctionsDir, "_ignore", "index.ts")
		require.NoError(t, afero.WriteFile(fsys, ignorePath, []byte{}, 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions").
			MatchParam("slug", slug).
			ParamPresent("import_map_path").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		// Run test
		err = Run(context.Background(), nil, true, nil, "", 1, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skip disabled functions from config", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile(utils.ConfigPath, os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.disabled-func]
enabled = false
import_map = "./import_map.json"
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		importMapPath, err := filepath.Abs(filepath.Join(utils.SupabaseDirPath, "import_map.json"))
		require.NoError(t, err)
		require.NoError(t, afero.WriteFile(fsys, importMapPath, []byte("{}"), 0644))
		// Setup function entrypoints
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.FunctionsDir, "enabled-func", "index.ts"), []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.FunctionsDir, "disabled-func", "index.ts"), []byte{}, 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions").
			MatchParam("slug", "enabled-func").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		// Setup output file
		outputDir := filepath.Join(utils.TempDir, ".output_enabled-func")
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		// Run test
		err = Run(context.Background(), nil, true, nil, "", 1, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := Run(context.Background(), []string{"_invalid"}, true, nil, "", 1, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on empty functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := Run(context.Background(), nil, true, nil, "", 1, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "No Functions specified or found in supabase/functions")
	})

	t.Run("verify_jwt param falls back to config", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile(utils.ConfigPath, os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions").
			MatchParam("verify_jwt", "false").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		// Run test
		assert.NoError(t, Run(context.Background(), []string{slug}, true, nil, "", 1, false, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("verify_jwt flag overrides config", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile(utils.ConfigPath, os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/"+flags.ProjectRef+"/functions").
			MatchParam("verify_jwt", "true").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "bundled"))
		// Setup output file
		outputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(outputDir, "output.eszip"), []byte(""), 0644))
		// Run test
		noVerifyJWT := false
		assert.NoError(t, Run(context.Background(), []string{slug}, true, &noVerifyJWT, "", 1, false, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestImportMapPath(t *testing.T) {
	t.Run("loads import map from default location", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc, err := GetFunctionConfig([]string{"test"}, "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, utils.FallbackImportMapPath, fc["test"].ImportMap)
	})

	t.Run("per function config takes precedence", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		slug := "hello"
		utils.Config.Functions = config.FunctionConfig{
			slug: {ImportMap: "import_map.json"},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc, err := GetFunctionConfig([]string{slug}, "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "import_map.json", fc[slug].ImportMap)
	})

	t.Run("overrides with cli flag", func(t *testing.T) {
		t.Cleanup(func() { clear(utils.Config.Functions) })
		slug := "hello"
		utils.Config.Functions = config.FunctionConfig{
			slug: {ImportMap: "import_map.json"},
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Custom global import map loaded via cli flag
		customImportMapPath := filepath.Join(utils.FunctionsDir, "custom_import_map.json")
		require.NoError(t, afero.WriteFile(fsys, customImportMapPath, []byte("{}"), 0644))
		// Create fallback import map to test precedence order
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc, err := GetFunctionConfig([]string{slug}, customImportMapPath, cast.Ptr(false), fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, customImportMapPath, fc[slug].ImportMap)
	})

	t.Run("returns empty string if no fallback", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		fc, err := GetFunctionConfig([]string{"test"}, "", nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, fc["test"].ImportMap)
	})

	t.Run("preserves absolute path", func(t *testing.T) {
		path := "/tmp/import_map.json"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte("{}"), 0644))
		// Run test
		fc, err := GetFunctionConfig([]string{"test"}, path, nil, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, path, fc["test"].ImportMap)
	})
}

func TestPruneFunctions(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	viper.Set("YES", true)

	t.Run("prunes functions not in local directory", func(t *testing.T) {
		// Setup function entrypoints
		localFunctions := config.FunctionConfig{
			"local-func-1": {Enabled: true},
			"local-func-2": {Enabled: true},
		}
		// Setup mock api - remote functions include local ones plus orphaned ones
		defer gock.OffAll()
		remoteFunctions := []api.FunctionResponse{
			{Slug: "local-func-1"},
			{Slug: "local-func-2"},
			{Slug: "orphaned-func-1"},
			{Slug: "orphaned-func-2"},
		}
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON(remoteFunctions)
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/functions/orphaned-func-1").
			Reply(http.StatusOK)
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/functions/orphaned-func-2").
			Reply(http.StatusOK)
		// Run test with prune and force (to skip confirmation)
		err := pruneFunctions(context.Background(), localFunctions)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips pruning when no orphaned functions", func(t *testing.T) {
		// Setup function entrypoints
		localFunctions := config.FunctionConfig{
			"local-func-1": {},
			"local-func-2": {},
		}
		// Setup mock api - remote functions match local ones exactly
		defer gock.OffAll()
		remoteFunctions := []api.FunctionResponse{
			{Slug: "local-func-1"},
			{Slug: "local-func-2"},
			{Slug: "orphaned-func-1", Status: api.FunctionResponseStatusREMOVED},
			{Slug: "orphaned-func-2", Status: api.FunctionResponseStatusREMOVED},
		}
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON(remoteFunctions)
		// Run test with prune and force
		err := pruneFunctions(context.Background(), localFunctions)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles 404 on delete gracefully", func(t *testing.T) {
		// Setup function entrypoints
		localFunctions := config.FunctionConfig{"local-func": {}}
		// Setup mock api
		defer gock.OffAll()
		remoteFunctions := []api.FunctionResponse{
			{Slug: "local-func"},
			{Slug: "orphaned-func"},
		}
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/functions").
			Reply(http.StatusOK).
			JSON(remoteFunctions)
		// Mock delete endpoint with 404 (function already deleted)
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/functions/orphaned-func").
			Reply(http.StatusNotFound)
		// Run test with prune and force
		err := pruneFunctions(context.Background(), localFunctions)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
