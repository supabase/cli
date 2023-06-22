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
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
)

const (
	dockerFuncDirPath = utils.DockerDenoDir + "/functions"
	// Import Map from CLI flag, i.e. --import-map, takes priority over config.toml & fallback.
	dockerFlagImportMapPath     = utils.DockerDenoDir + "/flag_import_map.json"
	dockerFallbackImportMapPath = utils.DockerDenoDir + "/fallback_import_map.json"
)

var (
	//go:embed templates/main.ts
	mainFuncEmbed string
)

// TODO: Remove deno relay code once we're confident w/ the stability of edge runtime.
func Run(ctx context.Context, slug string, envFilePath string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	if len(slug) == 0 {
		return runServeAll(ctx, envFilePath, noVerifyJWT, importMapPath, fsys)
	}

	// 1. Sanity checks.
	fmt.Fprintf(os.Stderr, "Serving functions with legacy %s... Run %s instead to use Edge Runtime.\n", utils.Yellow(utils.DenoRelayImage), utils.Aqua("functions serve"))
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
		if envFilePath != "" {
			if _, err := fsys.Stat(envFilePath); err != nil {
				return fmt.Errorf("Failed to read env file: %w", err)
			}
		}
		resolved, err := utils.AbsImportMapPath(importMapPath, slug, fsys)
		if err != nil {
			return err
		}
		importMapPath = resolved
	}

	// 2. Parse user defined env
	userEnv, err := parseEnvFile(envFilePath, fsys)
	if err != nil {
		return err
	}

	// 3. Start relay.
	{
		_ = utils.Docker.ContainerRemove(ctx, utils.DenoRelayId, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		})

		env := []string{
			"JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			"DENO_ORIGIN=http://localhost:8000",
		}
		verifyJWTEnv := "VERIFY_JWT=true"
		if noVerifyJWT == nil {
			if functionConfig, ok := utils.Config.Functions[slug]; ok && !*functionConfig.VerifyJWT {
				verifyJWTEnv = "VERIFY_JWT=false"
			}
		} else if *noVerifyJWT {
			verifyJWTEnv = "VERIFY_JWT=false"
		}
		env = append(env, verifyJWTEnv)

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		binds := []string{filepath.Join(cwd, utils.FunctionsDir) + ":" + dockerFuncDirPath + ":rw,z"}
		// If a import map path is explcitly provided, mount it as a separate file
		if importMapPath != "" {
			binds = append(binds, importMapPath+":"+dockerFlagImportMapPath+":ro,z")
		}
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.DenoRelayImage,
				Env:   append(env, userEnv...),
			},
			container.HostConfig{
				Binds: binds,
				// Allows containerized functions on Linux to reach host OS
				ExtraHosts: []string{"host.docker.internal:host-gateway"},
			},
			utils.DenoRelayId,
		); err != nil {
			return err
		}

		go func() {
			<-ctx.Done()
			if ctx.Err() != nil {
				utils.DockerRemove(utils.DenoRelayId)
			}
		}()
	}

	// 4. Start Function.
	localFuncDir := filepath.Join(utils.FunctionsDir, slug)
	localImportMapPath := filepath.Join(localFuncDir, "import_map.json")

	// We assume the image is always Linux, so path separator must always be `/`.
	// We can't use filepath.Join because it uses the path separator for the host system, which is `\` for Windows.
	dockerFuncPath := dockerFuncDirPath + "/" + slug + "/index.ts"
	dockerImportMapPath := dockerFuncDirPath + "/" + slug + "/import_map.json"

	if importMapPath != "" {
		localImportMapPath = importMapPath
		dockerImportMapPath = dockerFlagImportMapPath
	}

	denoCacheCmd := []string{"deno", "cache"}
	{
		if _, err := fsys.Stat(localImportMapPath); err == nil {
			denoCacheCmd = append(denoCacheCmd, "--import-map="+dockerImportMapPath)
		} else if errors.Is(err, os.ErrNotExist) {
			// skip
		} else {
			return fmt.Errorf("failed to check import_map.json for function %s: %w", slug, err)
		}
		denoCacheCmd = append(denoCacheCmd, dockerFuncPath)
	}

	fmt.Println("Starting " + utils.Bold(localFuncDir))
	if _, err := utils.DockerExecOnce(ctx, utils.DenoRelayId, userEnv, denoCacheCmd); err != nil {
		return err
	}

	{
		fmt.Println("Serving " + utils.Bold(localFuncDir))

		env := []string{
			"SUPABASE_URL=http://" + utils.KongId + ":8000",
			"SUPABASE_ANON_KEY=" + utils.Config.Auth.AnonKey,
			"SUPABASE_SERVICE_ROLE_KEY=" + utils.Config.Auth.ServiceRoleKey,
			"SUPABASE_DB_URL=postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres",
		}

		denoRunCmd := []string{"deno", "run", "--no-check=remote", "--allow-all", "--watch", "--no-clear-screen", "--no-npm"}
		{
			if _, err := fsys.Stat(localImportMapPath); err == nil {
				denoRunCmd = append(denoRunCmd, "--import-map="+dockerImportMapPath)
			} else if errors.Is(err, os.ErrNotExist) {
				// skip
			} else {
				return fmt.Errorf("failed to check index.ts for function %s: %w", slug, err)
			}
			denoRunCmd = append(denoRunCmd, dockerFuncPath)
		}

		exec, err := utils.Docker.ContainerExecCreate(
			ctx,
			utils.DenoRelayId,
			types.ExecConfig{
				Env:          append(env, userEnv...),
				Cmd:          denoRunCmd,
				AttachStderr: true,
				AttachStdout: true,
			},
		)
		if err != nil {
			return err
		}

		resp, err := utils.Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
		if err != nil {
			return err
		}

		if _, err := stdcopy.StdCopy(os.Stdout, os.Stderr, resp.Reader); err != nil {
			return err
		}
	}

	fmt.Println("Stopped serving " + utils.Bold(localFuncDir))
	return nil
}

func runServeAll(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// 2. Remove existing container.
	_ = utils.Docker.ContainerRemove(ctx, utils.DenoRelayId, types.ContainerRemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	})
	// 3. Serve and log to console
	dbUrl := "postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres"
	if err := ServeFunctions(ctx, envFilePath, noVerifyJWT, importMapPath, dbUrl, os.Stderr, fsys); err != nil {
		return err
	}
	if err := utils.DockerStreamLogs(ctx, utils.DenoRelayId, os.Stdout, os.Stderr); err != nil {
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
		"SUPABASE_INTERNAL_FUNCTIONS_PATH=" + dockerFuncDirPath,
	}
	if viper.GetBool("DEBUG") {
		env = append(env, "SUPABASE_INTERNAL_DEBUG=true")
	}
	// 3. Parse custom import map
	binds := []string{
		filepath.Join(cwd, utils.FunctionsDir) + ":" + dockerFuncDirPath + ":rw,z",
		utils.DenoRelayId + ":/root/.cache/deno:rw,z",
	}
	if importMapPath != "" {
		modules, err := bindImportMap(importMapPath, dockerFlagImportMapPath, fsys)
		if err != nil {
			return err
		}
		binds = append(binds, modules...)
	}

	fallbackImportMapPath := filepath.Join(cwd, utils.FallbackImportMapPath)
	if exists, err := afero.Exists(fsys, fallbackImportMapPath); err != nil {
		return fmt.Errorf("Failed to read fallback import map: %w", err)
	} else if !exists {
		fallbackImportMapPath = absTempImportMapPath(cwd, utils.ImportMapsDir)
		if err := utils.WriteFile(fallbackImportMapPath, []byte(`{"imports":{}}`), fsys); err != nil {
			return err
		}
	}
	modules, err := bindImportMap(fallbackImportMapPath, dockerFallbackImportMapPath, fsys)
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
		},
		start.WithSyslogConfig(container.HostConfig{
			Binds:      binds,
			ExtraHosts: []string{"host.docker.internal:host-gateway"},
		}),
		utils.DenoRelayId,
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
			modules, err := bindImportMap(hostImportMapPath, dockerImportMapPath, fsys)
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

func bindImportMap(hostImportMapPath, dockerImportMapPath string, fsys afero.Fs) ([]string, error) {
	importMap, err := utils.NewImportMap(hostImportMapPath, fsys)
	if err != nil {
		return nil, err
	}
	resolved := importMap.Resolve(fsys)
	binds := importMap.BindModules(resolved)
	if len(binds) > 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		contents, err := json.MarshalIndent(resolved, "", "    ")
		if err != nil {
			return nil, err
		}
		// Rewrite import map to temporary host path
		hostImportMapPath = absTempImportMapPath(cwd, hostImportMapPath)
		if err := utils.WriteFile(hostImportMapPath, contents, fsys); err != nil {
			return nil, err
		}
	}
	binds = append(binds, hostImportMapPath+":"+dockerImportMapPath+":ro,z")
	return binds, nil
}

func absTempImportMapPath(cwd, hostPath string) string {
	name := utils.GetPathHash(hostPath) + ".json"
	return filepath.Join(cwd, utils.ImportMapsDir, name)
}
