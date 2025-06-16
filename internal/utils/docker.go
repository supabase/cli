package utils

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/containerd/errdefs"
	podman "github.com/containers/common/libnetwork/types"
	"github.com/docker/cli/cli/command"
	"github.com/docker/cli/cli/compose/loader"
	dockerConfig "github.com/docker/cli/cli/config"
	dockerFlags "github.com/docker/cli/cli/flags"
	"github.com/docker/cli/cli/streams"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/versions"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-errors/errors"
	"github.com/spf13/viper"
	"go.opentelemetry.io/otel"
)

var Docker = NewDocker()

func NewDocker() *client.Client {
	// TODO: refactor to initialize lazily
	cli, err := command.NewDockerCli()
	if err != nil {
		log.Fatalln("Failed to create Docker client:", err)
	}
	// Silence otel errors as users don't care about docker metrics
	// 2024/08/12 23:11:12 1 errors occurred detecting resource:
	// 	* conflicting Schema URL: https://opentelemetry.io/schemas/1.21.0
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(cause error) {}))
	if err := cli.Initialize(&dockerFlags.ClientOptions{}); err != nil {
		log.Fatalln("Failed to initialize Docker client:", err)
	}
	return cli.Client().(*client.Client)
}

const (
	DinDHost            = "host.docker.internal"
	CliProjectLabel     = "com.supabase.cli.project"
	composeProjectLabel = "com.docker.compose.project"
)

func DockerNetworkCreateIfNotExists(ctx context.Context, mode container.NetworkMode, labels map[string]string) error {
	// Non-user defined networks should already exist
	if !isUserDefined(mode) {
		return nil
	}
	_, err := Docker.NetworkCreate(ctx, mode.NetworkName(), network.CreateOptions{Labels: labels})
	// if error is network already exists, no need to propagate to user
	if errdefs.IsConflict(err) || errors.Is(err, podman.ErrNetworkExists) {
		return nil
	}
	if err != nil {
		return errors.Errorf("failed to create docker network: %w", err)
	}
	return err
}

func WaitAll[T any](containers []T, exec func(container T) error) []error {
	var wg sync.WaitGroup
	result := make([]error, len(containers))
	for i, container := range containers {
		wg.Add(1)
		go func(i int, container T) {
			defer wg.Done()
			result[i] = exec(container)
		}(i, container)
	}
	wg.Wait()
	return result
}

// NoBackupVolume TODO: encapsulate this state in a class
var NoBackupVolume = false

func DockerRemoveAll(ctx context.Context, w io.Writer, projectId string) error {
	fmt.Fprintln(w, "Stopping containers...")
	args := CliProjectFilter(projectId)
	containers, err := Docker.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return errors.Errorf("failed to list containers: %w", err)
	}
	// Gracefully shutdown containers
	var ids []string
	for _, c := range containers {
		if c.State == "running" {
			ids = append(ids, c.ID)
		}
	}
	result := WaitAll(ids, func(id string) error {
		if err := Docker.ContainerStop(ctx, id, container.StopOptions{}); err != nil {
			return errors.Errorf("failed to stop container: %w", err)
		}
		return nil
	})
	if err := errors.Join(result...); err != nil {
		return err
	}
	if report, err := Docker.ContainersPrune(ctx, args); err != nil {
		return errors.Errorf("failed to prune containers: %w", err)
	} else if viper.GetBool("DEBUG") {
		fmt.Fprintln(os.Stderr, "Pruned containers:", report.ContainersDeleted)
	}
	// Remove named volumes
	if NoBackupVolume {
		vargs := args.Clone()
		if versions.GreaterThanOrEqualTo(Docker.ClientVersion(), "1.42") {
			// Since docker engine 25.0.3, all flag is required to include named volumes.
			// https://github.com/docker/cli/blob/master/cli/command/volume/prune.go#L76
			vargs.Add("all", "true")
		}
		if report, err := Docker.VolumesPrune(ctx, vargs); err != nil {
			return errors.Errorf("failed to prune volumes: %w", err)
		} else if viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, "Pruned volumes:", report.VolumesDeleted)
		}
	}
	// Remove networks.
	if report, err := Docker.NetworksPrune(ctx, args); err != nil {
		return errors.Errorf("failed to prune networks: %w", err)
	} else if viper.GetBool("DEBUG") {
		fmt.Fprintln(os.Stderr, "Pruned network:", report.NetworksDeleted)
	}
	return nil
}

func CliProjectFilter(projectId string) filters.Args {
	if len(projectId) == 0 {
		return filters.NewArgs(
			filters.Arg("label", CliProjectLabel),
		)
	}
	return filters.NewArgs(
		filters.Arg("label", CliProjectLabel+"="+projectId),
	)
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
		auth, err := config.GetAuthConfig(GetRegistry())
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

func GetRegistry() string {
	registry := viper.GetString("INTERNAL_IMAGE_REGISTRY")
	if len(registry) == 0 {
		return defaultRegistry
	}
	return strings.ToLower(registry)
}

func GetRegistryImageUrl(imageName string) string {
	registry := GetRegistry()
	if registry == "docker.io" {
		return imageName
	}
	// Configure mirror registry
	parts := strings.Split(imageName, "/")
	imageName = parts[len(parts)-1]
	return registry + "/supabase/" + imageName
}

func DockerImagePull(ctx context.Context, imageTag string, w io.Writer) error {
	out, err := Docker.ImagePull(ctx, imageTag, image.PullOptions{
		RegistryAuth: GetRegistryAuth(),
	})
	if err != nil {
		return errors.Errorf("failed to pull docker image: %w", err)
	}
	defer out.Close()
	if err := jsonmessage.DisplayJSONMessagesToStream(out, streams.NewOut(w), nil); err != nil {
		return errors.Errorf("failed to display json stream: %w", err)
	}
	return nil
}

// Used by unit tests
var timeUnit = time.Second

func DockerImagePullWithRetry(ctx context.Context, image string, retries int) error {
	err := DockerImagePull(ctx, image, os.Stderr)
	for i := 0; i < retries; i++ {
		if err == nil || errors.Is(ctx.Err(), context.Canceled) {
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
	if _, err := Docker.ImageInspect(ctx, imageUrl); err == nil {
		return nil
	} else if !errdefs.IsNotFound(err) {
		return errors.Errorf("failed to inspect docker image: %w", err)
	}
	return DockerImagePullWithRetry(ctx, imageUrl, 2)
}

var suggestDockerInstall = "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop"

func DockerStart(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string) (string, error) {
	// Pull container image
	if err := DockerPullImageIfNotCached(ctx, config.Image); err != nil {
		if client.IsErrConnectionFailed(err) {
			CmdSuggestion = suggestDockerInstall
		}
		return "", err
	}
	// Setup default config
	config.Image = GetRegistryImageUrl(config.Image)
	if config.Labels == nil {
		config.Labels = make(map[string]string, 2)
	}
	config.Labels[CliProjectLabel] = Config.ProjectId
	config.Labels[composeProjectLabel] = Config.ProjectId
	// Configure container network
	hostConfig.ExtraHosts = append(hostConfig.ExtraHosts, extraHosts...)
	if networkId := viper.GetString("network-id"); len(networkId) > 0 {
		hostConfig.NetworkMode = container.NetworkMode(networkId)
	} else if len(hostConfig.NetworkMode) == 0 {
		hostConfig.NetworkMode = container.NetworkMode(NetId)
	}
	if err := DockerNetworkCreateIfNotExists(ctx, hostConfig.NetworkMode, config.Labels); err != nil {
		return "", err
	}
	// Configure container volumes
	var binds, sources []string
	for _, bind := range hostConfig.Binds {
		spec, err := loader.ParseVolume(bind)
		if err != nil {
			return "", errors.Errorf("failed to parse docker volume: %w", err)
		}
		if spec.Type != string(mount.TypeVolume) {
			binds = append(binds, bind)
		} else if len(spec.Source) > 0 {
			sources = append(sources, spec.Source)
		}
	}
	// Skip named volume for BitBucket pipeline
	if os.Getenv("BITBUCKET_CLONE_DIR") != "" {
		hostConfig.Binds = binds
		// Bitbucket doesn't allow for --security-opt option to be set
		// https://support.atlassian.com/bitbucket-cloud/docs/run-docker-commands-in-bitbucket-pipelines/#Full-list-of-restricted-commands
		hostConfig.SecurityOpt = nil
	} else {
		// Create named volumes with labels
		for _, name := range sources {
			if _, err := Docker.VolumeCreate(ctx, volume.CreateOptions{
				Name:   name,
				Labels: config.Labels,
			}); err != nil {
				return "", errors.Errorf("failed to create volume: %w", err)
			}
		}
	}
	// Create container from image
	resp, err := Docker.ContainerCreate(ctx, &config, &hostConfig, &networkingConfig, nil, containerName)
	if err != nil {
		return "", errors.Errorf("failed to create docker container: %w", err)
	}
	// Run container in background
	err = Docker.ContainerStart(ctx, resp.ID, container.StartOptions{})
	if err != nil {
		if hostPort := parsePortBindError(err); len(hostPort) > 0 {
			CmdSuggestion = suggestDockerStop(ctx, hostPort)
			prefix := "Or configure"
			if len(CmdSuggestion) == 0 {
				prefix = "Try configuring"
			}
			name := containerName
			if endpoint, ok := networkingConfig.EndpointsConfig[NetId]; ok && len(endpoint.Aliases) > 0 {
				name = endpoint.Aliases[0]
			}
			CmdSuggestion += fmt.Sprintf("\n%s a different %s port in %s", prefix, name, Bold(ConfigPath))
		}
		err = errors.Errorf("failed to start docker container: %w", err)
	}
	return resp.ID, err
}

func DockerRemove(containerId string) {
	if err := Docker.ContainerRemove(context.Background(), containerId, container.RemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to remove container:", containerId, err)
	}
}

type DockerJob struct {
	Image string
	Env   []string
	Cmd   []string
}

func DockerRunJob(ctx context.Context, job DockerJob, stdout, stderr io.Writer) error {
	return DockerRunOnceWithStream(ctx, job.Image, job.Env, job.Cmd, stdout, stderr)
}

// Runs a container image exactly once, returning stdout and throwing error on non-zero exit code.
func DockerRunOnce(ctx context.Context, image string, env []string, cmd []string) (string, error) {
	stderr := GetDebugLogger()
	var out bytes.Buffer
	err := DockerRunOnceWithStream(ctx, image, env, cmd, &out, stderr)
	return out.String(), err
}

func DockerRunOnceWithStream(ctx context.Context, image string, env, cmd []string, stdout, stderr io.Writer) error {
	return DockerRunOnceWithConfig(ctx, container.Config{
		Image: image,
		Env:   env,
		Cmd:   cmd,
	}, container.HostConfig{}, network.NetworkingConfig{}, "", stdout, stderr)
}

func DockerRunOnceWithConfig(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string, stdout, stderr io.Writer) error {
	// Cannot rely on docker's auto remove because
	//   1. We must inspect exit code after container stops
	//   2. Context cancellation may happen after start
	container, err := DockerStart(ctx, config, hostConfig, networkingConfig, containerName)
	if err != nil {
		return err
	}
	defer DockerRemove(container)
	return DockerStreamLogs(ctx, container, stdout, stderr)
}

var ErrContainerKilled = errors.New("exit 137")

func DockerStreamLogs(ctx context.Context, containerId string, stdout, stderr io.Writer, opts ...func(*container.LogsOptions)) error {
	logsOptions := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
	}
	for _, apply := range opts {
		apply(&logsOptions)
	}
	// Stream logs
	logs, err := Docker.ContainerLogs(ctx, containerId, logsOptions)
	if err != nil {
		return errors.Errorf("failed to read docker logs: %w", err)
	}
	defer logs.Close()
	if _, err := stdcopy.StdCopy(stdout, stderr, logs); err != nil {
		return errors.Errorf("failed to copy docker logs: %w", err)
	}
	// Check exit code
	resp, err := Docker.ContainerInspect(ctx, containerId)
	if err != nil {
		return errors.Errorf("failed to inspect docker container: %w", err)
	}
	switch resp.State.ExitCode {
	case 0:
		return nil
	case 137:
		err = ErrContainerKilled
	default:
		err = errors.Errorf("exit %d", resp.State.ExitCode)
	}
	return errors.Errorf("error running container: %w", err)
}

func DockerStreamLogsOnce(ctx context.Context, containerId string, stdout, stderr io.Writer) error {
	logs, err := Docker.ContainerLogs(ctx, containerId, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	})
	if err != nil {
		return errors.Errorf("failed to read docker logs: %w", err)
	}
	defer logs.Close()
	if _, err := stdcopy.StdCopy(stdout, stderr, logs); err != nil {
		return errors.Errorf("failed to copy docker logs: %w", err)
	}
	return nil
}

// Exec a command once inside a container, returning stdout and throwing error on non-zero exit code.
func DockerExecOnce(ctx context.Context, containerId string, env []string, cmd []string) (string, error) {
	stderr := io.Discard
	if viper.GetBool("DEBUG") {
		stderr = os.Stderr
	}
	var out bytes.Buffer
	err := DockerExecOnceWithStream(ctx, containerId, "", env, cmd, &out, stderr)
	return out.String(), err
}

func DockerExecOnceWithStream(ctx context.Context, containerId, workdir string, env, cmd []string, stdout, stderr io.Writer) error {
	// Reset shadow database
	exec, err := Docker.ContainerExecCreate(ctx, containerId, container.ExecOptions{
		Env:          env,
		Cmd:          cmd,
		WorkingDir:   workdir,
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		return errors.Errorf("failed to exec docker create: %w", err)
	}
	// Read exec output
	resp, err := Docker.ContainerExecAttach(ctx, exec.ID, container.ExecStartOptions{})
	if err != nil {
		return errors.Errorf("failed to exec docker attach: %w", err)
	}
	defer resp.Close()
	// Capture error details
	if _, err := stdcopy.StdCopy(stdout, stderr, resp.Reader); err != nil {
		return errors.Errorf("failed to copy docker logs: %w", err)
	}
	// Get the exit code
	iresp, err := Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return errors.Errorf("failed to exec docker inspect: %w", err)
	}
	if iresp.ExitCode > 0 {
		err = errors.New("error executing command")
	}
	return err
}

func IsDockerRunning(ctx context.Context) bool {
	_, err := Docker.Ping(ctx)
	return !client.IsErrConnectionFailed(err)
}

var portErrorPattern = regexp.MustCompile("Bind for (.*) failed: port is already allocated")

func parsePortBindError(err error) string {
	matches := portErrorPattern.FindStringSubmatch(err.Error())
	if len(matches) > 1 {
		return matches[len(matches)-1]
	}
	return ""
}

func suggestDockerStop(ctx context.Context, hostPort string) string {
	if containers, err := Docker.ContainerList(ctx, container.ListOptions{}); err == nil {
		for _, c := range containers {
			for _, p := range c.Ports {
				if fmt.Sprintf("%s:%d", p.IP, p.PublicPort) == hostPort {
					if project, ok := c.Labels[CliProjectLabel]; ok {
						return "\nTry stopping the running project with " + Aqua("supabase stop --project-id "+project)
					} else {
						name := c.ID
						if len(c.Names) > 0 {
							name = c.Names[0]
						}
						return "\nTry stopping the running container with " + Aqua("docker stop "+name)
					}
				}
			}
		}
	}
	return ""
}
