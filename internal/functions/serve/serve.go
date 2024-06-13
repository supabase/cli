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
	"github.com/supabase/cli/internal/functions/deploy"
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

type RuntimeOption struct {
	InspectMode *InspectMode
	InspectMain bool
}

func (i *RuntimeOption) toArgs() []string {
	flags := []string{}
	if i.InspectMode != nil {
		flags = append(flags, fmt.Sprintf("--%s=0.0.0.0:%d", i.InspectMode.toFlag(), dockerRuntimeInspectorPort))
		if i.InspectMain {
			flags = append(flags, "--inspect-main")
		}
	}
	return flags
}

const (
	dockerRuntimeServerPort    = 8081
	dockerRuntimeInspectorPort = 8083
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
	dbUrl := fmt.Sprintf("postgresql://postgres:postgres@%s:5432/postgres", utils.DbAliases[0])
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
	} else if !filepath.IsAbs(envFilePath) {
		envFilePath = filepath.Join(utils.CurrentDirAbs, envFilePath)
	}
	// 2. Parse user defined env
	env, err := parseEnvFile(envFilePath, fsys)
	if err != nil {
		return err
	}
	hostFuncDir, err := filepath.Abs(utils.FunctionsDir)
	if err != nil {
		return errors.Errorf("failed to resolve functions dir: %w", err)
	}
	dockerFuncDir := utils.ToDockerPath(hostFuncDir)
	env = append(env,
		fmt.Sprintf("SUPABASE_URL=http://%s:8000", utils.KongAliases[0]),
		"SUPABASE_ANON_KEY="+utils.Config.Auth.AnonKey,
		"SUPABASE_SERVICE_ROLE_KEY="+utils.Config.Auth.ServiceRoleKey,
		"SUPABASE_DB_URL="+dbUrl,
		"SUPABASE_INTERNAL_JWT_SECRET="+utils.Config.Auth.JwtSecret,
		fmt.Sprintf("SUPABASE_INTERNAL_HOST_PORT=%d", utils.Config.Api.Port),
		"SUPABASE_INTERNAL_FUNCTIONS_PATH="+dockerFuncDir,
	)
	if viper.GetBool("DEBUG") {
		env = append(env, "SUPABASE_INTERNAL_DEBUG=true")
	}
	if runtimeOption.InspectMode != nil {
		env = append(env, "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0")
	}
	// 3. Parse custom import map
	binds, functionsConfigString, err := populatePerFunctionConfigs(importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	binds = append(binds,
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId+":/root/.cache/deno:rw",
		hostFuncDir+":"+dockerFuncDir+":rw",
	)
	env = append(env, "SUPABASE_INTERNAL_FUNCTIONS_CONFIG="+functionsConfigString)
	// 4. Parse entrypoint script
	cmd := append([]string{
		"edge-runtime",
		"start",
		"--main-service=.",
		fmt.Sprintf("--port=%d", dockerRuntimeServerPort),
		fmt.Sprintf("--policy=%s", utils.Config.EdgeRuntime.Policy),
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
			Env:          env,
			Entrypoint:   entrypoint,
			ExposedPorts: exposedPorts,
			WorkingDir:   utils.DockerDenoDir,
			// No tcp health check because edge runtime logs them as client connection error
		},
		start.WithSyslogConfig(container.HostConfig{
			Binds:        binds,
			PortBindings: portBindings,
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

func populatePerFunctionConfigs(importMapPath string, noVerifyJWT *bool, fsys afero.Fs) ([]string, string, error) {
	slugs, err := deploy.GetFunctionSlugs(fsys)
	if err != nil {
		return nil, "", err
	}

	binds := []string{}
	functionsConfig := make(map[string]interface{}, len(slugs))
	for _, functionName := range slugs {
		fc := utils.GetFunctionConfig(functionName, importMapPath, noVerifyJWT, fsys)
		if fc.ImportMap != "" {
			modules, dockerImportMapPath, err := utils.BindImportMap(fc.ImportMap, fsys)
			if err != nil {
				return nil, "", err
			}
			binds = append(binds, modules...)
			fc.ImportMap = dockerImportMapPath
		}
		functionsConfig[functionName] = fc
	}

	functionsConfigBytes, err := json.Marshal(functionsConfig)
	if err != nil {
		return nil, "", errors.Errorf("failed to marshal config json: %w", err)
	}

	return utils.RemoveDuplicates(binds), string(functionsConfigBytes), nil
}
