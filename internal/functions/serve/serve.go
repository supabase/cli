package serve

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(slug string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfig(); err != nil {
			return err
		}
		if err := utils.AssertSupabaseStartIsRunning(); err != nil {
			return err
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Stop on SIGINT/SIGTERM.
	{
		termCh := make(chan os.Signal, 1)
		signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-termCh
			_ = utils.Docker.ContainerRemove(ctx, utils.DenoRelayId, types.ContainerRemoveOptions{
				RemoveVolumes: true,
				Force:         true,
			})
		}()
	}

	// 3. Start relay.
	{
		_ = utils.Docker.ContainerRemove(ctx, utils.DenoRelayId, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		})

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.DenoRelayId,
			&container.Config{
				Image: utils.DenoRelayImage,
				Env: []string{
					"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
					"DENO_ORIGIN=http://localhost:8000",
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{
				Binds:       []string{cwd + "/supabase/functions:/home/deno/functions:ro,z"},
				NetworkMode: container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}
	}

	// 4. Start Function.
	{
		fmt.Println("Starting " + utils.Bold("supabase/functions/"+slug))
		out, err := utils.DockerExec(ctx, utils.DenoRelayId, []string{
			"deno", "cache", "/home/deno/functions/" + slug + "/index.ts",
		})
		if err != nil {
			return err
		}
		if _, err := stdcopy.StdCopy(io.Discard, io.Discard, out); err != nil {
			return err
		}
	}

	{
		fmt.Println("Serving " + utils.Bold("supabase/functions/"+slug))
		out, err := utils.DockerExec(ctx, utils.DenoRelayId, []string{
			"deno", "run", "--allow-all", "--watch", "/home/deno/functions/" + slug + "/index.ts",
		})
		if err != nil {
			return err
		}
		if _, err := stdcopy.StdCopy(os.Stdout, os.Stderr, out); err != nil {
			return err
		}
	}

	fmt.Println("Stopped serving " + utils.Bold("supabase/functions/"+slug))
	return nil
}
