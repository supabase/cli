package start

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	docker "github.com/docker/docker/client"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/remote"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"

	"github.com/spf13/viper"
)

// RunRemote starts Supabase services on a remote Daytona VM
func RunRemote(ctx context.Context, fsys afero.Fs, excludedContainers []string, ignoreHealthCheck bool) error {
	// Load config
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	// Create remote session
	// coldStart is true if VM was stopped/new (needs Docker daemon restart)
	// coldStart is false if VM was already running (warm reconnect)
	session, coldStart, err := remote.StartRemoteSession(ctx, utils.Config.ProjectId)
	if err != nil {
		return errors.Errorf("failed to start remote session: %w", err)
	}

	// Ensure cleanup on error or panic
	cleanup := func() {
		fmt.Fprintln(os.Stderr, "Cleaning up remote session...")
		if err := remote.StopRemoteSession(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "Warning: failed to clean up remote session:", err)
		}
	}
	// Defer cleanup to handle panics - will be called even if we panic
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "Panic recovered: %v\n", r)
			cleanup()
			panic(r) // Re-panic after cleanup
		}
	}()

	if coldStart {
		// Cold start: VM was stopped or newly created - need to start Docker daemon
		fmt.Fprintln(os.Stderr, "Starting Docker daemon...")
		cleanupCmd := strings.Join([]string{
			"pkill -9 dockerd containerd 2>/dev/null",
			"rm -f /var/run/docker.pid",
			"rm -f /var/run/containerd/containerd.pid",
			"rm -f /var/run/docker/containerd/containerd.pid",
			"rm -f /var/run/docker.sock",
			"rm -f /var/run/docker/containerd/containerd.sock",
			"nohup dockerd -H unix:///var/run/docker.sock -H tcp://127.0.0.1:2375 > /tmp/dockerd.log 2>&1 &",
		}, "; ")
		session.Exec(ctx, cleanupCmd)
	} else {
		fmt.Fprintln(os.Stderr, "Reconnecting to running VM...")
	}

	// Set up port forwards first (including Docker API port 2375)
	// This allows us to connect to Docker via TCP
	if err := session.ForwardAllSupabasePorts(ctx); err != nil {
		cleanup()
		return errors.Errorf("failed to set up port forwards: %w", err)
	}

	// Create Docker client via TCP (using forwarded port 2375)
	dockerClient, err := remote.GetRemoteDockerClient()
	if err != nil {
		cleanup()
		return errors.Errorf("failed to create Docker client: %w", err)
	}

	// Wait for Docker daemon to be ready
	fmt.Fprintln(os.Stderr, "Waiting for Docker daemon...")
	for i := 0; i < 30; i++ {
		// Use timeout context for ping to avoid hanging
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, pingErr := dockerClient.Ping(pingCtx)
		cancel()

		if pingErr == nil {
			fmt.Fprintln(os.Stderr, "Docker daemon ready.")
			break
		}

		fmt.Fprintf(os.Stderr, "  attempt %d/30: %v\n", i+1, pingErr)

		if i == 29 {
			if coldStart {
				logOutput, _ := session.Exec(ctx, "cat /tmp/dockerd.log 2>&1 | tail -20")
				fmt.Fprintln(os.Stderr, "Docker daemon log:", logOutput)
			}
			cleanup()
			return errors.New("Docker daemon failed to start after 15 seconds")
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Replace global Docker client
	utils.Docker = dockerClient

	if coldStart {
		// Force remove all stale containers from previous session
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Cleaning up any stale containers...")
		containers, _ := dockerClient.ContainerList(ctx, container.ListOptions{All: true})
		if len(containers) > 0 {
			fmt.Fprintf(os.Stderr, "Removing %d stale containers...\n", len(containers))
			for _, c := range containers {
				dockerClient.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true})
			}
		}

		// Remove the database volume to start fresh (no backup restore)
		// This makes cold starts faster for development
		fmt.Fprintln(os.Stderr, "Removing database volume for fresh start...")
		dockerClient.VolumeRemove(ctx, utils.DbId, true) // force=true to remove even if in use

		// Load pre-pulled images from snapshot
		fmt.Fprintln(os.Stderr)
		if err := loadRemoteImages(ctx, session, dockerClient); err != nil {
			cleanup()
			return errors.Errorf("failed to load images: %w", err)
		}
	}

	// Use Docker Hub images (we pre-pulled from docker.io, not public.ecr.aws)
	viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")

	// Note: Kong is pre-pulled (network issues with library/ namespace)
	// All other images pull from network at runtime

	// Run the standard Supabase start flow with our remote Docker client
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Starting Supabase services on remote Docker...")
	if err := Run(ctx, fsys, excludedContainers, ignoreHealthCheck); err != nil {
		cleanup()
		return err
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Started %s remote development setup.\n", utils.Aqua("supabase"))
	remote.PrintConnectionInfo()

	// Keep running until interrupted
	// Handle multiple signals: Ctrl+C, kill, and terminal close
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Press Ctrl+C to stop...")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	<-sigChan

	fmt.Fprintln(os.Stderr)
	cleanup()
	return nil
}

// loadRemoteImages loads pre-pulled Kong image from tarball (if not already loaded)
// Kong is the only image we pre-pull because it has network issues from library/ namespace
// All other images pull fine from network via normal docker pull
func loadRemoteImages(ctx context.Context, session *remote.Session, client *docker.Client) error {
	// Check if Kong is already loaded (e.g., VM was stopped and restarted)
	kongRef := "kong:2.8.1"
	images, err := client.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return errors.Errorf("failed to list images: %w", err)
	}

	kongLoaded := false
	for _, img := range images {
		for _, tag := range img.RepoTags {
			if strings.Contains(tag, "kong") && strings.Contains(tag, "2.8.1") {
				kongLoaded = true
				break
			}
		}
	}

	if kongLoaded {
		fmt.Fprintln(os.Stderr, "Kong image already loaded, skipping tarball import.")
		return nil
	}

	// Load Kong from tarball (baked into snapshot)
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Loading %s from snapshot tarball...\n", kongRef)
	loadOutput, err := session.Exec(ctx, "docker load < /var/lib/supabase-images/kong.tar 2>&1")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to load Kong image: %v\n", err)
	} else {
		fmt.Fprintln(os.Stderr, loadOutput)
	}

	return nil
}
