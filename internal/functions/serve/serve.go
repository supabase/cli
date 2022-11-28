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
	relayFuncDir = "/home/deno/functions"
)

func Run(ctx context.Context, slug string, envFilePath string, verifyJWT bool, fsys afero.Fs) error {
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

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.DenoRelayImage,
				Env:   env,
			},
			container.HostConfig{
				Binds: []string{filepath.Join(cwd, utils.FunctionsDir) + ":" + relayFuncDir + ":ro,z"},
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
	dockerFuncPath := relayFuncDir + "/" + slug + "/index.ts"
	fmt.Println("Starting " + utils.Bold(localFuncDir))
	if _, err := utils.DockerExecOnce(ctx, utils.DenoRelayId, nil, []string{
		"deno", "cache", dockerFuncPath,
	}); err != nil {
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

		exec, err := utils.Docker.ContainerExecCreate(
			ctx,
			utils.DenoRelayId,
			types.ExecConfig{
				Env: env,
				Cmd: []string{
					"deno", "run", "--no-check=remote", "--allow-all", "--watch", "--no-clear-screen", "--no-npm", dockerFuncPath,
				},
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
