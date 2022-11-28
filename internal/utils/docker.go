package utils

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
)

var Docker = NewDocker()

func NewDocker() *client.Client {
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
}

func AssertDockerIsRunning() error {
	if _, err := Docker.Ping(context.Background()); err != nil {
		return NewError(err.Error())
	}

	return nil
}

func DockerNetworkCreateIfNotExists(ctx context.Context, networkId string) error {
	_, err := Docker.NetworkCreate(
		ctx,
		networkId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   Config.ProjectId,
				"com.docker.compose.project": Config.ProjectId,
			},
		},
	)
	// if error is network already exists, no need to propagate to user
	if errdefs.IsConflict(err) {
		return nil
	}
	return err
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
	config.Image = GetRegistryImageUrl(config.Image)
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

func DockerRemoveContainers(ctx context.Context, containers []string) {
	var wg sync.WaitGroup

	for _, container := range containers {
		wg.Add(1)

		go func(container string) {
			if err := Docker.ContainerRemove(ctx, container, types.ContainerRemoveOptions{
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

func DockerRemoveAll(ctx context.Context, netId string) {
	DockerRemoveContainers(ctx, containers)
	_ = Docker.NetworkRemove(ctx, netId)
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

func GetRegistryImageUrl(imageName string) string {
	const hub = "docker.io"
	const ecr = "public.ecr.aws/t3w2s2c9"
	registry := viper.GetString("INTERNAL_IMAGE_REGISTRY")
	registry = strings.ToLower(registry)
	if registry == "" {
		// Defaults to Supabase public ECR for faster image pull
		registry = ecr
	}
	if registry == ecr {
		parts := strings.Split(imageName, "/")
		imageName = parts[len(parts)-1]
	}
	if registry == hub {
		return imageName
	}
	return registry + "/" + imageName
}

func DockerImagePullWithRetry(ctx context.Context, image string, retries int) (io.ReadCloser, error) {
	out, err := Docker.ImagePull(ctx, image, types.ImagePullOptions{})
	for i := time.Duration(1); retries > 0; retries-- {
		if err == nil {
			break
		}
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintf(os.Stderr, "Retrying after %d seconds...\n", i)
		time.Sleep(i * time.Second)
		out, err = Docker.ImagePull(ctx, image, types.ImagePullOptions{})
		i *= 2
	}
	return out, err
}

func DockerPullImageIfNotCached(ctx context.Context, imageName string) error {
	imageUrl := GetRegistryImageUrl(imageName)
	if _, _, err := Docker.ImageInspectWithRaw(ctx, imageUrl); err == nil {
		return nil
	} else if !client.IsErrNotFound(err) {
		return err
	}
	out, err := DockerImagePullWithRetry(ctx, imageUrl, 2)
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

func DockerStop(containerID string) {
	stopContainer(Docker, containerID)
}

func stopContainer(docker *client.Client, containerID string) {
	if err := docker.ContainerStop(context.Background(), containerID, nil); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to stop container:", containerID, err)
	}
}

func DockerStart(ctx context.Context, config container.Config, hostConfig container.HostConfig, containerName string) (string, error) {
	// Pull container image
	if err := DockerPullImageIfNotCached(ctx, config.Image); err != nil {
		return "", err
	}
	// Setup default config
	config.Image = GetRegistryImageUrl(config.Image)
	if config.Labels == nil {
		config.Labels = map[string]string{}
	}
	config.Labels["com.supabase.cli.project"] = Config.ProjectId
	config.Labels["com.docker.compose.project"] = Config.ProjectId
	if len(hostConfig.NetworkMode) == 0 {
		hostConfig.NetworkMode = container.NetworkMode(NetId)
	}
	// Create network with name
	if err := DockerNetworkCreateIfNotExists(ctx, string(hostConfig.NetworkMode)); err != nil {
		return "", err
	}
	// Create container from image
	resp, err := Docker.ContainerCreate(ctx, &config, &hostConfig, nil, nil, containerName)
	if err != nil {
		return "", err
	}
	containers = append(containers, resp.ID)
	// Run container in background
	return resp.ID, Docker.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{})
}

// Runs a container image exactly once, returning stdout and throwing error on non-zero exit code.
func DockerRunOnce(ctx context.Context, image string, env []string, cmd []string) (string, error) {
	container, err := DockerStart(ctx, container.Config{
		Image: image,
		Env:   env,
		Cmd:   cmd,
	}, container.HostConfig{AutoRemove: true}, "")
	if err != nil {
		return "", err
	}
	// Propagate cancellation to terminate early
	go func() {
		<-ctx.Done()
		if ctx.Err() != nil {
			stopContainer(NewDocker(), container)
		}
	}()
	// Stream logs
	logs, err := Docker.ContainerLogs(ctx, container, types.ContainerLogsOptions{
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
	resp, err := Docker.ContainerInspect(ctx, container)
	if err != nil {
		return "", err
	}
	if resp.State.ExitCode > 0 {
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
		err = errors.New("error executing command")
	}
	return out.String(), err
}
