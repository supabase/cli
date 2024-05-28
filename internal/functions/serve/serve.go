package serve

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/secrets/set"
	"github.com/supabase/cli/internal/utils"
)

type InspectMode string

const (
	InspectModeRun  InspectMode = "run"
	InspectModeBrk  InspectMode = "brk"
	InspectModeWait InspectMode = "wait"
)

func (mode InspectMode) toFlag() string {
	switch mode {
	case InspectModeBrk:
		return "inspect-brk"
	case InspectModeWait:
		return "inspect-wait"
	case InspectModeRun:
		fallthrough
	default:
		return "inspect"
	}
}

type Policy string

const (
	PolicyPerWorker Policy = "per_worker"
	PolicyOneshot   Policy = "oneshot"
)

type RuntimeOption struct {
	Policy            Policy
	InspectMode       *InspectMode
	WithInspectorMain bool
}

func (i *RuntimeOption) toArgs() []string {
	flags := []string{fmt.Sprintf("--policy=%s", i.Policy)}
	if i.InspectMode != nil {
		flags = append(flags, fmt.Sprintf("--%s=0.0.0.0:%d", i.InspectMode.toFlag(), dockerRuntimeInspectorPort))
		if i.WithInspectorMain {
			flags = append(flags, "--inspect-main")
		}
	}
	return flags
}

const (
	// Import Map from CLI flag, i.e. --import-map, takes priority over config.toml & fallback.
	dockerFlagImportMapPath     = utils.DockerDenoDir + "/flag_import_map.json"
	dockerFallbackImportMapPath = utils.DockerDenoDir + "/fallback_import_map.json"
	dockerRuntimeMainPath       = utils.DockerDenoDir + "/main"
	dockerRuntimeServerPort     = 8081
	dockerRuntimeInspectorPort  = 8083
)

var (
	//go:embed templates/main.ts
	mainFuncEmbed string
)

func Run(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, runtimeOption RuntimeOption, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// 2. Remove existing container.
	_ = utils.Docker.ContainerRemove(ctx, utils.EdgeRuntimeId, container.RemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	})
	// Use network alias because Deno cannot resolve `_` in hostname
	dbUrl := "postgresql://postgres:postgres@" + utils.DbAliases[0] + ":5432/postgres"
	// 3. Serve and log to console
	if err := ServeFunctions(ctx, envFilePath, noVerifyJWT, importMapPath, dbUrl, runtimeOption, os.Stderr, fsys); err != nil {
		return err
	}
	if err := utils.DockerStreamLogs(ctx, utils.EdgeRuntimeId, os.Stdout, os.Stderr); err != nil {
		return err
	}
	fmt.Println("Stopped serving " + utils.Bold(utils.FunctionsDir))
	return nil
}

func ServeFunctions(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, dbUrl string, runtimeOption RuntimeOption, w io.Writer, fsys afero.Fs) error {
	// 1. Load default values
	if envFilePath == "" {
		if f, err := fsys.Stat(utils.FallbackEnvFilePath); err == nil && !f.IsDir() {
			envFilePath = utils.FallbackEnvFilePath
		}
	} else if _, err := fsys.Stat(envFilePath); err != nil {
		return errors.Errorf("Failed to read env file: %w", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return errors.Errorf("failed to get working directory: %w", err)
	}
	if importMapPath != "" {
		if !filepath.IsAbs(importMapPath) {
			importMapPath = filepath.Join(cwd, importMapPath)
		}
		if _, err := fsys.Stat(importMapPath); err != nil {
			return errors.Errorf("Failed to read import map: %w", err)
		}
	}
	// 2. Parse user defined env
	userEnv, err := parseEnvFile(envFilePath, fsys)
	if err != nil {
		return err
	}
	env := []string{
		"SUPABASE_URL=http://" + utils.KongAliases[0] + ":8000",
		"SUPABASE_ANON_KEY=" + utils.Config.Auth.AnonKey,
		"SUPABASE_SERVICE_ROLE_KEY=" + utils.Config.Auth.ServiceRoleKey,
		"SUPABASE_DB_URL=" + dbUrl,
		"SUPABASE_INTERNAL_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
		fmt.Sprintf("SUPABASE_INTERNAL_HOST_PORT=%d", utils.Config.Api.Port),
		"SUPABASE_INTERNAL_FUNCTIONS_PATH=" + utils.DockerFuncDirPath,
	}
	if viper.GetBool("DEBUG") {
		env = append(env, "SUPABASE_INTERNAL_DEBUG=true")
	}
	if runtimeOption.InspectMode != nil {
		env = append(env, "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0")
	}
	// 3. Parse custom import map
	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw,z",
		filepath.Join(cwd, utils.FunctionsDir) + ":" + utils.DockerFuncDirPath + ":rw,z",
	}
	if importMapPath != "" {
		modules, err := utils.BindImportMap(importMapPath, dockerFlagImportMapPath, fsys)
		if err != nil {
			return err
		}
		binds = append(binds, modules...)
	}

	fallbackImportMapPath := filepath.Join(cwd, utils.FallbackImportMapPath)
	if exists, err := afero.Exists(fsys, fallbackImportMapPath); err != nil {
		return errors.Errorf("Failed to read fallback import map: %w", err)
	} else if !exists {
		fallbackImportMapPath = utils.AbsTempImportMapPath(cwd, utils.ImportMapsDir)
		if err := utils.WriteFile(fallbackImportMapPath, []byte(`{"imports":{}}`), fsys); err != nil {
			return err
		}
	}
	if fallbackImportMapPath != importMapPath {
		modules, err := utils.BindImportMap(fallbackImportMapPath, dockerFallbackImportMapPath, fsys)
		if err != nil {
			return err
		}
		binds = append(binds, modules...)
	}

	if err := utils.MkdirIfNotExistFS(fsys, utils.FunctionsDir); err != nil {
		return err
	}
	binds, functionsConfigString, err := populatePerFunctionConfigs(binds, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	env = append(env, "SUPABASE_INTERNAL_FUNCTIONS_CONFIG="+functionsConfigString)
	// 4. Parse entrypoint script
	cmd := append([]string{
		"edge-runtime",
		"start",
		"--main-service=.",
		fmt.Sprintf("--port=%d", dockerRuntimeServerPort),
	}, runtimeOption.toArgs()...)
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")

	entrypoint := []string{"sh", "-c", `cat <<'EOF' > index.ts && ` + cmdString + `
` + mainFuncEmbed + `
EOF
`}
	// 5. Parse exposed ports
	ports := []string{fmt.Sprintf("::%d/tcp", dockerRuntimeServerPort)}
	if runtimeOption.InspectMode != nil {
		ports = append(ports, fmt.Sprintf(":%d:%d/tcp", utils.Config.EdgeRuntime.InspectorPort, dockerRuntimeInspectorPort))
	}
	exposedPorts, portBindings, err := nat.ParsePortSpecs(ports)
	if err != nil {
		return errors.Errorf("failed to expose ports: %w", err)
	}
	// 6. Start container
	fmt.Fprintln(w, "Setting up Edge Functions runtime...")
	_, err = utils.DockerStart(
		ctx,
		container.Config{
			Image:        utils.EdgeRuntimeImage,
			Env:          append(env, userEnv...),
			Entrypoint:   entrypoint,
			ExposedPorts: exposedPorts,
			WorkingDir:   dockerRuntimeMainPath,
			// No tcp health check because edge runtime logs them as client connection error
		},
		start.WithSyslogConfig(container.HostConfig{
			Binds:        binds,
			PortBindings: portBindings,
			ExtraHosts:   []string{"host.docker.internal:host-gateway"},
		}),
		network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				utils.NetId: {
					Aliases: utils.EdgeRuntimeAliases,
				},
			},
		},
		utils.EdgeRuntimeId,
	)
	return err
}

func parseEnvFile(envFilePath string, fsys afero.Fs) ([]string, error) {
	env := []string{}
	if len(envFilePath) == 0 {
		return env, nil
	}
	envMap, err := set.ParseEnvFile(envFilePath, fsys)
	if err != nil {
		return env, err
	}
	for name, value := range envMap {
		if strings.HasPrefix(name, "SUPABASE_") {
			fmt.Fprintln(os.Stderr, "Env name cannot start with SUPABASE_, skipping: "+name)
			continue
		}
		env = append(env, name+"="+value)
	}
	return env, nil
}

func populatePerFunctionConfigs(binds []string, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) ([]string, string, error) {
	type functionConfig struct {
		ImportMapPath string `json:"importMapPath"`
		VerifyJWT     bool   `json:"verifyJWT"`
	}

	functionsConfig := map[string]functionConfig{}

	cwd, err := os.Getwd()
	if err != nil {
		return nil, "", errors.Errorf("failed to get working directory: %w", err)
	}

	functions, err := afero.ReadDir(fsys, utils.FunctionsDir)
	if err != nil {
		return nil, "", errors.Errorf("failed to read directory: %w", err)
	}
	for _, function := range functions {
		if !function.IsDir() {
			continue
		}

		functionName := function.Name()
		if !utils.FuncSlugPattern.MatchString(functionName) {
			continue
		}

		// CLI flags take priority over config.toml.

		dockerImportMapPath := dockerFallbackImportMapPath
		if importMapPath != "" {
			dockerImportMapPath = dockerFlagImportMapPath
		} else if functionConfig, ok := utils.Config.Functions[functionName]; ok && functionConfig.ImportMap != "" {
			dockerImportMapPath = utils.DockerDenoDir + "/import_maps/" + functionName + "/import_map.json"
			hostImportMapPath := filepath.Join(cwd, utils.SupabaseDirPath, functionConfig.ImportMap)
			modules, err := utils.BindImportMap(hostImportMapPath, dockerImportMapPath, fsys)
			if err != nil {
				return nil, "", err
			}
			binds = append(binds, modules...)
		}

		verifyJWT := true
		if noVerifyJWT != nil {
			verifyJWT = !*noVerifyJWT
		} else if functionConfig, ok := utils.Config.Functions[functionName]; ok && functionConfig.VerifyJWT != nil {
			verifyJWT = *functionConfig.VerifyJWT
		}

		functionsConfig[functionName] = functionConfig{
			ImportMapPath: dockerImportMapPath,
			VerifyJWT:     verifyJWT,
		}
	}

	functionsConfigBytes, err := json.Marshal(functionsConfig)
	if err != nil {
		return nil, "", errors.Errorf("failed to marshal config json: %w", err)
	}

	return binds, string(functionsConfigBytes), nil
}
