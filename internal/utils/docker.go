package utils

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
)

var Docker = func() *client.Client {
	docker, err := client.NewClientWithOpts(client.WithAPIVersionNegotiation())
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to initialize Docker client:", err)
		os.Exit(1)
	}
	return docker
}()

func AssertDockerIsRunning() error {
	if _, err := Docker.Ping(context.Background()); err != nil {
		return NewError(err.Error())
	}

	return nil
}

func DockerExec(ctx context.Context, container string, cmd []string) (io.Reader, error) {
	exec, err := Docker.ContainerExecCreate(
		ctx,
		container,
		types.ExecConfig{Cmd: cmd, AttachStderr: true, AttachStdout: true},
	)
	if err != nil {
		return nil, err
	}

	resp, err := Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return nil, err
	}

	if err := Docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		return nil, err
	}

	return resp.Reader, nil
}

// NOTE: There's a risk of data race with reads & writes from `DockerRun` and
// reads from `DockerRemoveAll`, but since they're expected to be run on the
// same thread, this is fine.
var containers []string

func DockerRun(
	ctx context.Context,
	name string,
	config *container.Config,
	hostConfig *container.HostConfig,
) (io.Reader, error) {
	container, err := Docker.ContainerCreate(ctx, config, hostConfig, nil, nil, name)
	if err != nil {
		return nil, err
	}
	containers = append(containers, name)

	resp, err := Docker.ContainerAttach(ctx, container.ID, types.ContainerAttachOptions{Stream: true, Stdout: true, Stderr: true})
	if err != nil {
		return nil, err
	}

	if err := Docker.ContainerStart(ctx, container.ID, types.ContainerStartOptions{}); err != nil {
		return nil, err
	}

	return resp.Reader, nil
}

func DockerRemoveAll() {
	var wg sync.WaitGroup

	for _, container := range containers {
		wg.Add(1)

		go func(container string) {
			if err := Docker.ContainerRemove(context.Background(), container, types.ContainerRemoveOptions{
				RemoveVolumes: true,
				Force:         true,
			}); err != nil {
				// TODO: Handle errors
				// fmt.Fprintln(os.Stderr, err)
				_ = err
			}

			wg.Done()
		}(container)
	}

	wg.Wait()
}

func GetProjectContainers(ctx context.Context) ([]types.Container, error) {
	return Docker.ContainerList(ctx, types.ContainerListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", "com.supabase.cli.project="+Config.ProjectId)),
	})
}

func ContainerName(names []string) string {
	service := strings.Join(names, " | ")

	if len(service) > 0 && service[0] == '/' {
		service = service[1:]
	}

	return service
}
