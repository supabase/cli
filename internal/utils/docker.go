package utils

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
)

var Docker = func() *client.Client {
	docker, err := client.NewClientWithOpts(
		client.WithAPIVersionNegotiation(),
		// Support env (e.g. for mock setup or rootless docker)
		client.FromEnv,
	)
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

func DockerAddFile(ctx context.Context, container string, fileName string, content []byte) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	err := tw.WriteHeader(&tar.Header{
		Name: fileName,
		Mode: 0777,
		Size: int64(len(content)),
	})

	if err != nil {
		return fmt.Errorf("failed to copy file: %v", err)
	}

	_, err = tw.Write(content)

	if err != nil {
		return fmt.Errorf("failed to copy file: %v", err)
	}

	err = tw.Close()

	if err != nil {
		return fmt.Errorf("failed to copy file: %v", err)
	}

	err = Docker.CopyToContainer(ctx, container, "/tmp", &buf, types.CopyToContainerOptions{})
	if err != nil {
		return fmt.Errorf("failed to copy file: %v", err)
	}
	return nil
}

func DockerPullImageIfNotCached(ctx context.Context, imageName string) error {
	imageUrl := "docker.io/" + imageName
	if _, _, err := Docker.ImageInspectWithRaw(ctx, imageUrl); err == nil {
		return nil
	}
	out, err := Docker.ImagePull(ctx, imageUrl, types.ImagePullOptions{})
	if err != nil {
		return err
	}
	defer out.Close()
	fmt.Fprintln(os.Stderr, "Pulling docker image...")
	if viper.GetBool("DEBUG") {
		return jsonmessage.DisplayJSONMessagesStream(out, os.Stderr, os.Stderr.Fd(), true, nil)
	}
	_, err = io.Copy(io.Discard, out)
	return err
}

// Runs a container image exactly once, returning stdout and throwing error on non-zero exit code.
func DockerRunOnce(ctx context.Context, image string, env []string, cmd []string) (string, error) {
	// Pull container image
	if err := DockerPullImageIfNotCached(ctx, image); err != nil {
		return "", err
	}
	// Create container from image
	resp, err := Docker.ContainerCreate(ctx, &container.Config{
		Image: image,
		Env:   env,
		Cmd:   cmd,
		Labels: map[string]string{
			"com.supabase.cli.project":   Config.ProjectId,
			"com.docker.compose.project": Config.ProjectId,
		},
	}, &container.HostConfig{
		NetworkMode: container.NetworkMode(NetId),
		AutoRemove:  true,
	}, nil, nil, "")
	if err != nil {
		return "", err
	}
	// Run container in background and propagate cancellation
	if err := Docker.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		return "", err
	}
	go func() {
		<-ctx.Done()
		if ctx.Err() != nil {
			if err := Docker.ContainerStop(context.Background(), resp.ID, nil); err != nil {
				fmt.Fprintln(os.Stderr, "Failed to stop container:", resp.ID, err)
			}
		}
	}()
	// Stream logs
	logs, err := Docker.ContainerLogs(ctx, resp.ID, types.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: viper.GetBool("DEBUG"),
		Follow:     true,
	})
	if err != nil {
		return "", err
	}
	defer logs.Close()
	var out bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, os.Stderr, logs); err != nil {
		return "", err
	}
	// Check exit code
	iresp, err := Docker.ContainerInspect(ctx, resp.ID)
	if err != nil {
		return "", err
	}
	if iresp.State.ExitCode > 0 {
		return "", errors.New("error running container")
	}
	return out.String(), nil
}

// Exec a command once inside a container, returning stdout and throwing error on non-zero exit code.
func DockerExecOnce(ctx context.Context, container string, env []string, cmd []string) (string, error) {
	// Reset shadow database
	exec, err := Docker.ContainerExecCreate(ctx, container, types.ExecConfig{
		Env:          env,
		Cmd:          cmd,
		AttachStderr: viper.GetBool("DEBUG"),
		AttachStdout: true,
	})
	if err != nil {
		return "", err
	}
	// Read exec output
	resp, err := Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return "", err
	}
	defer resp.Close()
	// Capture error details
	var out bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, os.Stderr, resp.Reader); err != nil {
		return "", err
	}
	// Get the exit code
	iresp, err := Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return "", err
	}
	if iresp.ExitCode > 0 {
		return "", errors.New("error executing command")
	}
	return out.String(), nil
}
