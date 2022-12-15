package serve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const (
	relayFuncDir              = "/home/deno/functions"
	customDockerImportMapPath = "/home/deno/import_map.json"
)

func Run(ctx context.Context, slug string, envFilePath string, verifyJWT bool, importMapPath string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
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
		if importMapPath != "" {
			if _, err := fsys.Stat(importMapPath); err != nil {
				return fmt.Errorf("Failed to read import map: %w", err)
			}
		}
	}

	// 3. Start relay.
	{
		_ = utils.Docker.ContainerRemove(ctx, utils.DenoRelayId, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		})

		env := []string{
			"JWT_SECRET=" + utils.JWTSecret,
			"DENO_ORIGIN=http://localhost:8000",
		}
		if verifyJWT {
			env = append(env, "VERIFY_JWT=true")
		} else {
			env = append(env, "VERIFY_JWT=false")
		}

		// mirror local DENO_* env variables to the Docker container.
		env = append(env,
			"DENO_TLS_CA_STORE="+os.Getenv("DENO_TLS_CA_STORE"),
			"DENO_CERT="+os.Getenv("DENO_CERT"),
			"DENO_AUTH_TOKENS="+os.Getenv("DENO_AUTH_TOKENS"),
		)

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		binds := []string{filepath.Join(cwd, utils.FunctionsDir) + ":" + relayFuncDir + ":ro,z"}
		// If a import map path is explcitly provided, mount it as a separate file
		if importMapPath != "" {
			binds = append(binds, filepath.Join(cwd, importMapPath)+":"+customDockerImportMapPath+":ro,z")
		}
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.DenoRelayImage,
				Env:   env,
			},
			container.HostConfig{
				Binds: binds,
			},
			utils.DenoRelayId,
		); err != nil {
			return err
		}

		go func() {
			<-ctx.Done()
			if ctx.Err() != nil {
				if err := utils.Docker.ContainerRemove(context.Background(), utils.DenoRelayId, types.ContainerRemoveOptions{
					RemoveVolumes: true,
					Force:         true,
				}); err != nil {
					fmt.Fprintln(os.Stderr, "Failed to remove container:", utils.DenoRelayId, err)
				}
			}
		}()
	}

	// 4. Start Function.
	localFuncDir := filepath.Join(utils.FunctionsDir, slug)
	localImportMapPath := filepath.Join(localFuncDir, "import_map.json")

	// We assume the image is always Linux, so path separator must always be `/`.
	// We can't use filepath.Join because it uses the path separator for the host system, which is `\` for Windows.
	dockerFuncPath := relayFuncDir + "/" + slug + "/index.ts"
	dockerImportMapPath := relayFuncDir + "/" + slug + "/import_map.json"

	if importMapPath != "" {
		localImportMapPath = importMapPath
		dockerImportMapPath = customDockerImportMapPath
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
	if _, err := utils.DockerExecOnce(ctx, utils.DenoRelayId, nil, denoCacheCmd); err != nil {
		return err
	}

	{
		fmt.Println("Serving " + utils.Bold(localFuncDir))

		env := []string{
			"SUPABASE_URL=http://" + utils.KongId + ":8000",
			"SUPABASE_ANON_KEY=" + utils.AnonKey,
			"SUPABASE_SERVICE_ROLE_KEY=" + utils.ServiceRoleKey,
			"SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:" + strconv.FormatUint(uint64(utils.Config.Db.Port), 10) + "/postgres",
		}

		if envFilePath != "" {
			envMap, err := godotenv.Read(envFilePath)
			if err != nil {
				return err
			}
			for name, value := range envMap {
				if strings.HasPrefix(name, "SUPABASE_") {
					return errors.New("Invalid secret name: " + name + ". Secret names cannot start with SUPABASE_.")
				}
				env = append(env, name+"="+value)
			}
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
				Env:          env,
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
