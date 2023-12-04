package serve

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
)

const (
	// Import Map from CLI flag, i.e. --import-map, takes priority over config.toml & fallback.
	dockerFlagImportMapPath     = utils.DockerDenoDir + "/flag_import_map.json"
	dockerFallbackImportMapPath = utils.DockerDenoDir + "/fallback_import_map.json"
)

var (
	//go:embed templates/main.ts
	mainFuncEmbed string
)

func Run(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// 2. Remove existing container.
	_ = utils.Docker.ContainerRemove(ctx, utils.EdgeRuntimeId, types.ContainerRemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	})
	// 3. Serve and log to console
	dbUrl := "postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres"
	if err := ServeFunctions(ctx, envFilePath, noVerifyJWT, importMapPath, dbUrl, os.Stderr, fsys); err != nil {
		return err
	}
	if err := utils.DockerStreamLogs(ctx, utils.EdgeRuntimeId, os.Stdout, os.Stderr); err != nil {
		return err
	}
	fmt.Println("Stopped serving " + utils.Bold(utils.FunctionsDir))
	return nil
}

func ServeFunctions(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, dbUrl string, w io.Writer, fsys afero.Fs) error {
	// 1. Load default values
	if envFilePath == "" {
		if f, err := fsys.Stat(utils.FallbackEnvFilePath); err == nil && !f.IsDir() {
			envFilePath = utils.FallbackEnvFilePath
		}
	} else if _, err := fsys.Stat(envFilePath); err != nil {
		return fmt.Errorf("Failed to read env file: %w", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	if importMapPath != "" {
		if !filepath.IsAbs(importMapPath) {
			importMapPath = filepath.Join(cwd, importMapPath)
		}
		if _, err := fsys.Stat(importMapPath); err != nil {
			return fmt.Errorf("Failed to read import map: %w", err)
		}
	}
	// 2. Parse user defined env
	userEnv, err := parseEnvFile(envFilePath, fsys)
	if err != nil {
		return err
	}
	env := []string{
		"SUPABASE_URL=http://" + utils.KongId + ":8000",
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
		return fmt.Errorf("Failed to read fallback import map: %w", err)
	} else if !exists {
		fallbackImportMapPath = utils.AbsTempImportMapPath(cwd, utils.ImportMapsDir)
		if err := utils.WriteFile(fallbackImportMapPath, []byte(`{"imports":{}}`), fsys); err != nil {
			return err
		}
	}
	modules, err := utils.BindImportMap(fallbackImportMapPath, dockerFallbackImportMapPath, fsys)
	if err != nil {
		return err
	}
	binds = append(binds, modules...)

	if err := utils.MkdirIfNotExistFS(fsys, utils.FunctionsDir); err != nil {
		return err
	}
	binds, functionsConfigString, err := populatePerFunctionConfigs(binds, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	env = append(env, "SUPABASE_INTERNAL_FUNCTIONS_CONFIG="+functionsConfigString)

	// 4. Start container
	fmt.Fprintln(w, "Setting up Edge Functions runtime...")

	var cmdString string
	{
		cmd := []string{"edge-runtime", "start", "--main-service", "/home/deno/main", "-p", "8081"}
		if viper.GetBool("DEBUG") {
			cmd = append(cmd, "--verbose")
		}
		cmdString = strings.Join(cmd, " ")
	}

	entrypoint := []string{"sh", "-c", `mkdir -p /home/deno/main && cat <<'EOF' > /home/deno/main/index.ts && ` + cmdString + `
` + mainFuncEmbed + `
EOF
`}
	_, err = utils.DockerStart(
		ctx,
		container.Config{
			Image:        utils.EdgeRuntimeImage,
			Env:          append(env, userEnv...),
			Entrypoint:   entrypoint,
			ExposedPorts: nat.PortSet{"8081/tcp": {}},
			// No tcp health check because edge runtime logs them as client connection error
		},
		start.WithSyslogConfig(container.HostConfig{
			Binds:      binds,
			ExtraHosts: []string{"host.docker.internal:host-gateway"},
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
	f, err := fsys.Open(envFilePath)
	if err != nil {
		return env, err
	}
	defer f.Close()
	envMap, err := godotenv.Parse(f)
	if err != nil {
		return env, err
	}
	for name, value := range envMap {
		if strings.HasPrefix(name, "SUPABASE_") {
			return env, errors.New("Invalid env name: " + name + ". Env names cannot start with SUPABASE_.")
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
		return nil, "", err
	}

	functions, err := afero.ReadDir(fsys, utils.FunctionsDir)
	if err != nil {
		return nil, "", err
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
			dockerImportMapPath = "/home/deno/import_maps/" + functionName + "/import_map.json"
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
		return nil, "", err
	}

	return binds, string(functionsConfigBytes), nil
}
