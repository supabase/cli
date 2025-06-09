package serve

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/secrets/set"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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

//go:embed templates/main.ts
var mainFuncEmbed string

func Run(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, runtimeOption RuntimeOption, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := flags.LoadConfig(fsys); err != nil {
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
	fmt.Fprintln(os.Stderr, "Setting up Edge Functions runtime...")
	if err := ServeFunctions(ctx, envFilePath, noVerifyJWT, importMapPath, dbUrl, runtimeOption, fsys); err != nil {
		return err
	}
	if err := utils.DockerStreamLogs(ctx, utils.EdgeRuntimeId, os.Stdout, os.Stderr); err != nil {
		return err
	}
	fmt.Println("Stopped serving " + utils.Bold(utils.FunctionsDir))
	return nil
}

func ServeFunctions(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, dbUrl string, runtimeOption RuntimeOption, fsys afero.Fs) error {
	// 1. Parse custom env file
	env, err := parseEnvFile(envFilePath, fsys)
	if err != nil {
		return err
	}
	env = append(env,
		fmt.Sprintf("SUPABASE_URL=http://%s:8000", utils.KongAliases[0]),
		"SUPABASE_ANON_KEY="+utils.Config.Auth.AnonKey.Value,
		"SUPABASE_SERVICE_ROLE_KEY="+utils.Config.Auth.ServiceRoleKey.Value,
		"SUPABASE_DB_URL="+dbUrl,
		"SUPABASE_INTERNAL_JWT_SECRET="+utils.Config.Auth.JwtSecret.Value,
		fmt.Sprintf("SUPABASE_INTERNAL_HOST_PORT=%d", utils.Config.Api.Port),
	)
	if viper.GetBool("DEBUG") {
		env = append(env, "SUPABASE_INTERNAL_DEBUG=true")
	}
	if runtimeOption.InspectMode != nil {
		env = append(env, "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0")
	}
	// 2. Parse custom import map
	cwd, err := os.Getwd()
	if err != nil {
		return errors.Errorf("failed to get working directory: %w", err)
	}
	if len(importMapPath) > 0 {
		if !filepath.IsAbs(importMapPath) {
			importMapPath = filepath.Join(utils.CurrentDirAbs, importMapPath)
		}
		if importMapPath, err = filepath.Rel(cwd, importMapPath); err != nil {
			return errors.Errorf("failed to resolve relative path: %w", err)
		}
	}
	binds, functionsConfigString, err := populatePerFunctionConfigs(cwd, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	env = append(env, "SUPABASE_INTERNAL_FUNCTIONS_CONFIG="+functionsConfigString)
	// 3. Parse entrypoint script
	cmd := append([]string{
		"edge-runtime",
		"start",
		"--main-service=/root",
		fmt.Sprintf("--port=%d", dockerRuntimeServerPort),
		fmt.Sprintf("--policy=%s", utils.Config.EdgeRuntime.Policy),
	}, runtimeOption.toArgs()...)
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")
	entrypoint := []string{"sh", "-c", `cat <<'EOF' > /root/index.ts && ` + cmdString + `
` + mainFuncEmbed + `
EOF
`}
	// 4. Parse exposed ports
	dockerRuntimePort := nat.Port(fmt.Sprintf("%d/tcp", dockerRuntimeServerPort))
	exposedPorts := nat.PortSet{dockerRuntimePort: struct{}{}}
	portBindings := nat.PortMap{}
	if runtimeOption.InspectMode != nil {
		dockerInspectorPort := nat.Port(fmt.Sprintf("%d/tcp", dockerRuntimeInspectorPort))
		exposedPorts[dockerInspectorPort] = struct{}{}
		portBindings[dockerInspectorPort] = []nat.PortBinding{{
			HostPort: strconv.FormatUint(uint64(utils.Config.EdgeRuntime.InspectorPort), 10),
		}}
	}
	// 5. Start container
	_, err = utils.DockerStart(
		ctx,
		container.Config{
			Image:        utils.Config.EdgeRuntime.Image,
			Env:          env,
			Entrypoint:   entrypoint,
			ExposedPorts: exposedPorts,
			WorkingDir:   utils.ToDockerPath(cwd),
			// No tcp health check because edge runtime logs them as client connection error
		},
		container.HostConfig{
			Binds:        binds,
			PortBindings: portBindings,
		},
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
	if envFilePath == "" {
		if f, err := fsys.Stat(utils.FallbackEnvFilePath); err == nil && !f.IsDir() {
			envFilePath = utils.FallbackEnvFilePath
		}
	} else if !filepath.IsAbs(envFilePath) {
		envFilePath = filepath.Join(utils.CurrentDirAbs, envFilePath)
	}
	env := []string{}
	secrets, err := set.ListSecrets(envFilePath, fsys)
	for _, v := range secrets {
		env = append(env, fmt.Sprintf("%s=%s", v.Name, v.Value))
	}
	return env, err
}

func populatePerFunctionConfigs(cwd, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) ([]string, string, error) {
	slugs, err := deploy.GetFunctionSlugs(fsys)
	if err != nil {
		return nil, "", err
	}
	functionsConfig, err := deploy.GetFunctionConfig(slugs, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return nil, "", err
	}
	binds := []string{}
	for slug, fc := range functionsConfig {
		if !fc.Enabled {
			fmt.Fprintln(os.Stderr, "Skipped serving Function:", slug)
			continue
		}
		modules, err := deploy.GetBindMounts(cwd, utils.FunctionsDir, "", fc.Entrypoint, fc.ImportMap, fsys)
		if err != nil {
			return nil, "", err
		}
		binds = append(binds, modules...)
		fc.ImportMap = utils.ToDockerPath(fc.ImportMap)
		fc.Entrypoint = utils.ToDockerPath(fc.Entrypoint)
		functionsConfig[slug] = fc
		for i, val := range fc.StaticFiles {
			fc.StaticFiles[i] = utils.ToDockerPath(val)
		}
	}
	functionsConfigBytes, err := json.Marshal(functionsConfig)
	if err != nil {
		return nil, "", errors.Errorf("failed to marshal config json: %w", err)
	}
	return utils.RemoveDuplicates(binds), string(functionsConfigBytes), nil
}
