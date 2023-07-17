package utils

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	podman "github.com/containers/common/libnetwork/types"
	"github.com/docker/cli/cli/command"
	"github.com/docker/cli/cli/compose/loader"
	dockerConfig "github.com/docker/cli/cli/config"
	dockerFlags "github.com/docker/cli/cli/flags"
	"github.com/docker/cli/cli/streams"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
)

var Docker = NewDocker()

func NewDocker() *client.Client {
	// TODO: refactor to initialise lazily
	cli, err := command.NewDockerCli()
	if err != nil {
		log.Fatalln("Failed to create Docker client:", err)
	}
	if err := cli.Initialize(&dockerFlags.ClientOptions{}); err != nil {
		log.Fatalln("Failed to initialize Docker client:", err)
	}
	return cli.Client().(*client.Client)
}

func AssertDockerIsRunning(ctx context.Context) error {
	if _, err := Docker.Ping(ctx); err != nil {
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
	if errdefs.IsConflict(err) || errors.Is(err, podman.ErrNetworkExists) {
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

// Used by unit tests
// NOTE: There's a risk of data race with reads & writes from `DockerRun` and
// reads from `DockerRemoveAll`, but since they're expected to be run on the
// same thread, this is fine.
var (
	Containers []string
	Volumes    []string
)

func WaitAll(containers []string, exec func(container string) error) []error {
	var wg sync.WaitGroup
	result := make([]error, len(containers))
	for i, container := range containers {
		wg.Add(1)
		go func(i int, container string) {
			defer wg.Done()
			result[i] = exec(container)
		}(i, container)
	}
	wg.Wait()
	return result
}

func DockerRemoveAll(ctx context.Context) {
	_ = WaitAll(Containers, func(container string) error {
		return Docker.ContainerRemove(ctx, container, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		})
	})
	_ = WaitAll(Volumes, func(name string) error {
		return Docker.VolumeRemove(ctx, name, true)
	})
	_ = Docker.NetworkRemove(ctx, NetId)
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

var (
	// Only supports one registry per command invocation
	registryAuth string
	registryOnce sync.Once
)

func GetRegistryAuth() string {
	registryOnce.Do(func() {
		config := dockerConfig.LoadDefaultConfigFile(os.Stderr)
		// Ref: https://docs.docker.com/engine/api/sdk/examples/#pull-an-image-with-authentication
		auth, err := config.GetAuthConfig(getRegistry())
		if err != nil {
			fmt.Fprintln(os.Stderr, "Failed to load registry credentials:", err)
			return
		}
		encoded, err := json.Marshal(auth)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Failed to serialise auth config:", err)
			return
		}
		registryAuth = base64.URLEncoding.EncodeToString(encoded)
	})
	return registryAuth
}

// Defaults to Supabase public ECR for faster image pull
const defaultRegistry = "public.ecr.aws"

func getRegistry() string {
	registry := viper.GetString("INTERNAL_IMAGE_REGISTRY")
	if len(registry) == 0 {
		return defaultRegistry
	}
	return strings.ToLower(registry)
}

func GetRegistryImageUrl(imageName string) string {
	registry := getRegistry()
	if registry == "docker.io" {
		return imageName
	}
	// Configure mirror registry
	parts := strings.Split(imageName, "/")
	imageName = parts[len(parts)-1]
	return registry + "/supabase/" + imageName
}

func DockerImagePull(ctx context.Context, image string, w io.Writer) error {
	out, err := Docker.ImagePull(ctx, image, types.ImagePullOptions{
		RegistryAuth: GetRegistryAuth(),
	})
	if err != nil {
		return err
	}
	defer out.Close()
	return jsonmessage.DisplayJSONMessagesToStream(out, streams.NewOut(w), nil)
}

// Used by unit tests
var timeUnit = time.Second

func DockerImagePullWithRetry(ctx context.Context, image string, retries int) error {
	err := DockerImagePull(ctx, image, os.Stderr)
	for i := 0; i < retries; i++ {
		if err == nil {
			break
		}
		fmt.Fprintln(os.Stderr, err)
		period := time.Duration(2<<(i+1)) * timeUnit
		fmt.Fprintf(os.Stderr, "Retrying after %v: %s\n", period, image)
		time.Sleep(period)
		err = DockerImagePull(ctx, image, os.Stderr)
	}
	return err
}

func DockerPullImageIfNotCached(ctx context.Context, imageName string) error {
	imageUrl := GetRegistryImageUrl(imageName)
	if _, _, err := Docker.ImageInspectWithRaw(ctx, imageUrl); err == nil {
		return nil
	} else if !client.IsErrNotFound(err) {
		return err
	}
	return DockerImagePullWithRetry(ctx, imageUrl, 2)
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
	if hostConfig.NetworkMode.IsUserDefined() && hostConfig.NetworkMode.UserDefined() != "host" {
		if err := DockerNetworkCreateIfNotExists(ctx, hostConfig.NetworkMode.NetworkName()); err != nil {
			return "", err
		}
	}
	// Create container from image
	resp, err := Docker.ContainerCreate(ctx, &config, &hostConfig, nil, nil, containerName)
	if err != nil {
		return "", err
	}
	// Track container id for cleanup
	Containers = append(Containers, resp.ID)
	for _, bind := range hostConfig.Binds {
		spec, err := loader.ParseVolume(bind)
		if err != nil {
			return "", err
		}
		// Track named volumes for cleanup
		if len(spec.Source) > 0 && spec.Type == string(mount.TypeVolume) {
			Volumes = append(Volumes, spec.Source)
		}
	}
	// Run container in background
	return resp.ID, Docker.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{})
}

func DockerRemove(containerId string) {
	if err := Docker.ContainerRemove(context.Background(), containerId, types.ContainerRemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to remove container:", containerId, err)
	}
}

// Runs a container image exactly once, returning stdout and throwing error on non-zero exit code.
func DockerRunOnce(ctx context.Context, image string, env []string, cmd []string) (string, error) {
	stderr := io.Discard
	if viper.GetBool("DEBUG") {
		stderr = os.Stderr
	}
	var out bytes.Buffer
	err := DockerRunOnceWithStream(ctx, image, env, cmd, &out, stderr)
	return out.String(), err
}

func DockerRunOnceWithStream(ctx context.Context, image string, env, cmd []string, stdout, stderr io.Writer) error {
	return DockerRunOnceWithConfig(ctx, container.Config{
		Image: image,
		Env:   env,
		Cmd:   cmd,
	}, container.HostConfig{}, "", stdout, stderr)
}

func DockerRunOnceWithConfig(ctx context.Context, config container.Config, hostConfig container.HostConfig, containerName string, stdout, stderr io.Writer) error {
	// Cannot rely on docker's auto remove because
	//   1. We must inspect exit code after container stops
	//   2. Context cancellation may happen after start
	container, err := DockerStart(ctx, config, hostConfig, containerName)
	if err != nil {
		return err
	}
	defer DockerRemove(container)
	return DockerStreamLogs(ctx, container, stdout, stderr)
}

func DockerStreamLogs(ctx context.Context, container string, stdout, stderr io.Writer) error {
	// Stream logs
	logs, err := Docker.ContainerLogs(ctx, container, types.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
	})
	if err != nil {
		return err
	}
	defer logs.Close()
	if _, err := stdcopy.StdCopy(stdout, stderr, logs); err != nil {
		return err
	}
	// Check exit code
	resp, err := Docker.ContainerInspect(ctx, container)
	if err != nil {
		return err
	}
	if resp.State.ExitCode > 0 {
		return fmt.Errorf("error running container: exit %d", resp.State.ExitCode)
	}
	return nil
}

// Exec a command once inside a container, returning stdout and throwing error on non-zero exit code.
func DockerExecOnce(ctx context.Context, container string, env []string, cmd []string) (string, error) {
	stderr := io.Discard
	if viper.GetBool("DEBUG") {
		stderr = os.Stderr
	}
	var out bytes.Buffer
	err := DockerExecOnceWithStream(ctx, container, "", env, cmd, &out, stderr)
	return out.String(), err
}

func DockerExecOnceWithStream(ctx context.Context, container, workdir string, env, cmd []string, stdout, stderr io.Writer) error {
	// Reset shadow database
	exec, err := Docker.ContainerExecCreate(ctx, container, types.ExecConfig{
		Env:          env,
		Cmd:          cmd,
		WorkingDir:   workdir,
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		return err
	}
	// Read exec output
	resp, err := Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return err
	}
	defer resp.Close()
	// Capture error details
	if _, err := stdcopy.StdCopy(stdout, stderr, resp.Reader); err != nil {
		return err
	}
	// Get the exit code
	iresp, err := Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return err
	}
	if iresp.ExitCode > 0 {
		err = errors.New("error executing command")
	}
	return err
}
