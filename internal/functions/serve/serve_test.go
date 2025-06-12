package serve

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"encoding/json"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/cast"
)

// Test helper functions
type TestSetup struct {
	T         *testing.T
	Fsys      afero.Fs
	Context   context.Context
	Cancel    context.CancelFunc
	ProjectId string
	RootPath  string
}

func NewTestSetup(t *testing.T) *TestSetup {
	fsys := afero.NewMemMapFs()
	ctx, cancel := context.WithCancel(context.Background())

	setup := &TestSetup{
		T:         t,
		Fsys:      fsys,
		Context:   ctx,
		Cancel:    cancel,
		ProjectId: "test",
		RootPath:  "/project",
	}

	// Initialize basic config
	require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: setup.ProjectId}, fsys))

	return setup
}

func (s *TestSetup) Cleanup() {
	s.Cancel()
	gock.OffAll()
}

// SetupFunction creates a test function with given name and content
func (s *TestSetup) SetupFunction(name, content string) {
	funcDir := filepath.Join(utils.FunctionsDir, name)
	require.NoError(s.T, s.Fsys.MkdirAll(funcDir, 0755))
	require.NoError(s.T, afero.WriteFile(s.Fsys, filepath.Join(funcDir, "index.ts"), []byte(content), 0644))
}

// SetupEnvFile creates an environment file with given content
func (s *TestSetup) SetupEnvFile(path, content string) {
	if path == "" {
		path = utils.FallbackEnvFilePath
	}
	require.NoError(s.T, afero.WriteFile(s.Fsys, path, []byte(content), 0644))
}

// SetupImportMap creates an import map file with given content
func (s *TestSetup) SetupImportMap(path, content string) {
	if path == "" {
		path = utils.FallbackImportMapPath
	}
	require.NoError(s.T, afero.WriteFile(s.Fsys, path, []byte(content), 0644))
}

// SetupConfigWithFunctions creates a supabase config.toml with function configurations
func (s *TestSetup) SetupConfigWithFunctions() {
	configContent := `[functions.hello]
enabled = true
verify_jwt = false

[functions.protected]
enabled = true
verify_jwt = true

[functions.goodbye]
enabled = false
verify_jwt = false`

	require.NoError(s.T, afero.WriteFile(s.Fsys, "supabase/config.toml", []byte(configContent), 0644))
}

func TestServeCommand(t *testing.T) {
	setupMockConfig := func() {
		utils.Config.Auth.AnonKey.Value = "anon_key"
		utils.Config.Auth.ServiceRoleKey.Value = "service_role_key"
		utils.Config.Auth.JwtSecret.Value = "jwt_secret"
		utils.Config.Api.Port = 8000
		utils.Config.EdgeRuntime.Policy = "permissive"
		utils.Config.EdgeRuntime.Image = "supabase/edge-runtime:test"
		utils.KongAliases = []string{"supabase_kong_test"}
		utils.EdgeRuntimeId = "supabase_edge_runtime_test"
	}

	t.Run("serves all functions", func(t *testing.T) {
		setupMockConfig()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test"}, fsys))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackEnvFilePath, []byte{}, 0644))
		require.NoError(t, afero.WriteFile(fsys, utils.FallbackImportMapPath, []byte{}, 0644))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_test/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		// Use the EdgeRuntimeId from the mock config
		containerId := utils.EdgeRuntimeId

		// Mock multiple container removal calls (for initial cleanup and during shutdown)
		for i := 0; i < 5; i++ {
			gock.New(utils.Docker.DaemonHost()).
				Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + containerId).
				Reply(http.StatusOK)
		}

		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), containerId)

		// Add multiple container inspect mocks for the log streaming logic
		for i := 0; i < 15; i++ {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + containerId + "/json").
				Reply(http.StatusOK).
				JSON(container.InspectResponse{
					ContainerJSONBase: &container.ContainerJSONBase{
						State: &container.State{
							Running: true,
						},
					},
				})
		}

		// Mock log streaming that will timeout gracefully
		for i := 0; i < 10; i++ {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v"+utils.Docker.ClientVersion()+"/containers/"+containerId+"/logs").
				Reply(http.StatusOK).
				SetHeader("Content-Type", "application/vnd.docker.raw-stream").
				Delay(300 * time.Millisecond). // Delay to ensure timeout
				Body(strings.NewReader(""))
		}

		// Create a context with timeout to prevent test from hanging
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Run test with timeout context
		err := Run(ctx, "", nil, "", RuntimeOption{}, fsys)
		// Check error - expect context.DeadlineExceeded because the server runs until cancelled
		assert.ErrorIs(t, err, context.DeadlineExceeded)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))

		// Run test
		err := Run(context.Background(), "", nil, "", RuntimeOption{}, fsys)
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
		err := Run(context.Background(), "", nil, "", RuntimeOption{}, fsys)
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
		err := Run(context.Background(), ".env", nil, "", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "open .env: file does not exist")
	})

	t.Run("throws error on missing import map", func(t *testing.T) {
		utils.CurrentDirAbs = "/"
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
		err := Run(context.Background(), ".env", cast.Ptr(true), "import_map.json", RuntimeOption{}, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}

func TestParseEnvFile(t *testing.T) {
	// Save original CurrentDirAbs
	originalCurrentDirAbs := utils.CurrentDirAbs
	defer func() {
		utils.CurrentDirAbs = originalCurrentDirAbs
	}()

	t.Run("parses env file successfully", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		envContent := `DATABASE_URL=postgresql://localhost:5432/test
API_KEY=secret123
DEBUG=true`
		envPath := "/project/.env"
		setup.SetupEnvFile(envPath, envContent)

		env, err := parseEnvFile(envPath, setup.Fsys)
		assert.NoError(t, err)
		assert.Contains(t, env, "DATABASE_URL=postgresql://localhost:5432/test")
		assert.Contains(t, env, "API_KEY=secret123")
		assert.Contains(t, env, "DEBUG=true")
	})

	t.Run("uses fallback env file when path is empty", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		envContent := `FALLBACK_VAR=fallback_value`
		setup.SetupEnvFile("", envContent)

		env, err := parseEnvFile("", setup.Fsys)
		assert.NoError(t, err)
		assert.Contains(t, env, "FALLBACK_VAR=fallback_value")
	})

	t.Run("returns error when file doesn't exist", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		envPath := "/project/nonexistent.env"
		env, err := parseEnvFile(envPath, setup.Fsys)
		assert.Error(t, err)
		assert.Nil(t, env)
		assert.Contains(t, err.Error(), "failed to open env file")
	})
}

func TestPopulatePerFunctionConfigs(t *testing.T) {
	// Save original values
	originalFunctionsDir := utils.FunctionsDir
	defer func() {
		utils.FunctionsDir = originalFunctionsDir
	}()

	t.Run("populates function configs successfully", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		utils.FunctionsDir = "functions"
		setup.SetupFunction("hello", "export default () => 'hello'")
		setup.SetupConfigWithFunctions()

		binds, configString, err := populatePerFunctionConfigs("/project", "", cast.Ptr(false), setup.Fsys)
		assert.NoError(t, err)
		assert.NotEmpty(t, binds)
		assert.NotEmpty(t, configString)

		var config map[string]interface{}
		err = json.Unmarshal([]byte(configString), &config)
		assert.NoError(t, err)
		assert.Contains(t, config, "hello")
	})

	t.Run("handles function config creation", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		utils.FunctionsDir = "functions"
		setup.SetupFunction("enabled", "export default () => 'enabled'")

		_, configString, err := populatePerFunctionConfigs("/project", "", nil, setup.Fsys)
		assert.NoError(t, err)

		var resultConfig map[string]interface{}
		err = json.Unmarshal([]byte(configString), &resultConfig)
		assert.NoError(t, err)
		assert.Contains(t, resultConfig, "enabled")

		enabledConfig := resultConfig["enabled"].(map[string]interface{})
		assert.Contains(t, enabledConfig, "entrypointPath")
		assert.Contains(t, enabledConfig, "verifyJWT")
	})

	t.Run("handles import map path", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		utils.FunctionsDir = "functions"
		setup.SetupFunction("hello", "export default () => 'hello'")
		setup.SetupImportMap("import_map.json", "{}")

		binds, configString, err := populatePerFunctionConfigs("/project", "import_map.json", nil, setup.Fsys)
		assert.NoError(t, err)
		assert.NotEmpty(t, binds)
		assert.NotEmpty(t, configString)
	})

	t.Run("returns empty config when no functions exist", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		utils.FunctionsDir = "functions"
		require.NoError(t, setup.Fsys.MkdirAll("functions", 0755))

		_, configString, err := populatePerFunctionConfigs("/project", "", nil, setup.Fsys)
		assert.NoError(t, err)

		var resultConfig map[string]interface{}
		err = json.Unmarshal([]byte(configString), &resultConfig)
		assert.NoError(t, err)
		assert.Empty(t, resultConfig)
	})
}

func TestServeFunctions(t *testing.T) {
	// Save original values
	originalConfig := utils.Config
	originalDebug := viper.Get("DEBUG")
	originalFunctionsDir := utils.FunctionsDir
	defer func() {
		utils.Config = originalConfig
		viper.Set("DEBUG", originalDebug)
		utils.FunctionsDir = originalFunctionsDir
	}()

	t.Run("returns error on env file parsing failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Test with nonexistent file to trigger error

		// Test function
		err := ServeFunctions(context.Background(), "nonexistent.env", nil, "", "postgresql://localhost:5432/test", RuntimeOption{}, fsys)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to open env file")
	})

	t.Run("returns error on function config failure", func(t *testing.T) {
		// Setup config
		utils.Config.Auth.AnonKey.Value = "anon_key"
		utils.Config.Auth.ServiceRoleKey.Value = "service_role_key"
		utils.Config.Auth.JwtSecret.Value = "jwt_secret"
		utils.Config.Api.Port = 8000
		utils.Config.EdgeRuntime.Policy = "permissive"
		utils.KongAliases = []string{"supabase_kong_test"}

		// Setup in-memory fs with invalid functions directory
		fsys := afero.NewMemMapFs()
		utils.FunctionsDir = "nonexistent"

		// Test function
		err := ServeFunctions(context.Background(), "", nil, "", "postgresql://localhost:5432/test", RuntimeOption{}, fsys)
		assert.Error(t, err)
	})
}

func TestRecreateContainer(t *testing.T) {
	// Save original values
	originalConfig := utils.Config
	defer func() {
		utils.Config = originalConfig
	}()

	setupMockConfig := func() {
		utils.Config.Auth.AnonKey.Value = "anon_key"
		utils.Config.Auth.ServiceRoleKey.Value = "service_role_key"
		utils.Config.Auth.JwtSecret.Value = "jwt_secret"
		utils.Config.Api.Port = 8000
		utils.Config.EdgeRuntime.Policy = "permissive"
		utils.Config.EdgeRuntime.Image = "supabase/edge-runtime:test"
		utils.KongAliases = []string{"supabase_kong_test"}
		utils.EdgeRuntimeId = "supabase_edge_runtime_test"
	}

	t.Run("recreates container successfully", func(t *testing.T) {
		setupMockConfig()

		// Setup in-memory fs
		fsys := afero.NewMemMapFs()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		// Mock container removal
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId).
			Reply(http.StatusOK)
		// Mock container start
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), utils.EdgeRuntimeId)

		// Test function
		err := recreateContainer(
			context.Background(),
			"",
			nil,
			"",
			"postgresql://localhost:5432/test",
			RuntimeOption{},
			fsys,
		)

		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("returns error when ServeFunctions fails", func(t *testing.T) {
		setupMockConfig()

		// Setup in-memory fs with nonexistent env file to trigger error
		fsys := afero.NewMemMapFs()

		// Setup mock docker for container removal
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Delete("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId).
			Reply(http.StatusOK)

		// Test function
		err := recreateContainer(
			context.Background(),
			"nonexistent.env",
			nil,
			"",
			"postgresql://localhost:5432/test",
			RuntimeOption{},
			fsys,
		)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "Failed to serve functions")
	})
}

func TestStartLogStreaming(t *testing.T) {
	// Save original values
	originalConfig := utils.Config
	defer func() {
		utils.Config = originalConfig
	}()

	setupMockConfig := func() {
		utils.Config.Auth.AnonKey.Value = "anon_key"
		utils.Config.Auth.ServiceRoleKey.Value = "service_role_key"
		utils.Config.Auth.JwtSecret.Value = "jwt_secret"
		utils.Config.Api.Port = 8000
		utils.Config.EdgeRuntime.Policy = "permissive"
		utils.Config.EdgeRuntime.Image = "supabase/edge-runtime:test"
		utils.KongAliases = []string{"supabase_kong_test"}
		utils.EdgeRuntimeId = "supabase_edge_runtime_test"
	}

	t.Run("starts log streaming successfully", func(t *testing.T) {
		setupMockConfig()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		// Mock container inspect for ready check
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{
				ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: true,
					},
				},
			})

		// Mock log streaming
		gock.New(utils.Docker.DaemonHost()).
			Get("/v"+utils.Docker.ClientVersion()+"/containers/"+utils.EdgeRuntimeId+"/logs").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/vnd.docker.raw-stream").
			Body(strings.NewReader("test log output"))

		// Create context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Create error channel
		errChan := make(chan error, 1)

		// Test function
		logCancel, logsDone := startLogStreaming(ctx, errChan)

		// Cancel immediately to ensure cleanup
		logCancel()

		// Wait for logs to be done or timeout
		select {
		case <-logsDone:
			// Expected
		case <-time.After(1 * time.Second):
			t.Error("Expected logsDone to close")
		}

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles container not ready", func(t *testing.T) {
		setupMockConfig()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		// Mock container inspect for not ready check
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{
				ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: false,
					},
				},
			})

		// Create context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Create error channel
		errChan := make(chan error, 1)

		// Test function
		logCancel, logsDone := startLogStreaming(ctx, errChan)

		// Cancel immediately to ensure cleanup
		logCancel()

		// Wait for logs to be done or timeout
		select {
		case <-logsDone:
			// Expected
		case <-time.After(1 * time.Second):
			t.Error("Expected logsDone to close")
		}

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles log streaming errors", func(t *testing.T) {
		setupMockConfig()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		// Mock container inspect for ready check
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{
				ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: true,
					},
				},
			})

		// Mock log streaming error
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/logs").
			Reply(http.StatusServiceUnavailable)

		// Create context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Create error channel
		errChan := make(chan error, 1)

		// Test function
		logCancel, logsDone := startLogStreaming(ctx, errChan)

		// Wait for error or timeout
		select {
		case err := <-errChan:
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "Docker log streaming error")
		case <-time.After(1 * time.Second):
			t.Error("Expected error in errChan")
		}

		// Cancel and wait for cleanup
		logCancel()
		select {
		case <-logsDone:
			// Expected
		case <-time.After(1 * time.Second):
			t.Error("Expected logsDone to close after cancel")
		}

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles full error channel gracefully", func(t *testing.T) {
		setupMockConfig()

		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()

		// Mock container inspect for ready check
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{
				ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: true,
					},
				},
			})

		// Mock log streaming error
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.EdgeRuntimeId + "/logs").
			Reply(http.StatusServiceUnavailable)

		// Create context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Create full error channel (capacity 0)
		errChan := make(chan error)

		// Test function
		logCancel, logsDone := startLogStreaming(ctx, errChan)

		// Cancel immediately to ensure cleanup
		logCancel()

		// Wait for cleanup - should not hang even with full error channel
		select {
		case <-logsDone:
			// Expected
		case <-time.After(1 * time.Second):
			t.Error("Expected logsDone to close even with full error channel")
		}

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
