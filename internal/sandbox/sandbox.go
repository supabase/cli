package sandbox

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/go-connections/nat"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// Run starts the sandbox mode with native binaries and process-compose.
// If detach is true (default), it spawns a background server and exits after services are healthy.
// If detach is false, it runs in foreground and responds to Ctrl+C.
func Run(ctx context.Context, fsys afero.Fs, detach bool) error {
	// 1. Load config
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	// 2. Create sandbox context with project namespacing
	sandboxCtx, err := NewSandboxContext(utils.Config.ProjectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// 3. Ensure directories exist
	if err := sandboxCtx.EnsureDirectories(fsys); err != nil {
		return fmt.Errorf("failed to create directories: %w", err)
	}

	// 4. Allocate dynamic ports
	fmt.Fprintln(os.Stderr, "Allocating ports...")
	sandboxCtx.Ports, err = AllocatePorts(ctx)
	if err != nil {
		return fmt.Errorf("failed to allocate ports: %w", err)
	}

	// 5. Save ports for stop command
	if err := sandboxCtx.SavePorts(fsys); err != nil {
		return fmt.Errorf("failed to save ports: %w", err)
	}

	// 6. Download service binaries if needed (shared across projects)
	fmt.Fprintln(os.Stderr, "Checking binaries...")
	if err := InstallBinaries(ctx, fsys, sandboxCtx.BinDir); err != nil {
		return fmt.Errorf("failed to install binaries: %w", err)
	}

	// 7. Generate nginx.conf for this sandbox instance
	fmt.Fprintln(os.Stderr, "Generating nginx configuration...")
	if err := WriteNginxConfig(sandboxCtx, fsys); err != nil {
		return fmt.Errorf("failed to write nginx config: %w", err)
	}

	// 8. Pre-create PostgreSQL container (so process-compose can just start it)
	fmt.Fprintln(os.Stderr, "Setting up PostgreSQL container...")
	if err := createPostgresContainer(ctx, sandboxCtx); err != nil {
		return fmt.Errorf("failed to create postgres container: %w", err)
	}

	// 9. Generate process-compose.yaml configuration
	fmt.Fprintln(os.Stderr, "Generating process-compose configuration...")
	processComposePath, err := WriteProcessComposeConfig(sandboxCtx, fsys)
	if err != nil {
		return fmt.Errorf("failed to write process-compose config: %w", err)
	}

	// 10. Print allocated ports
	printStartupInfo(sandboxCtx)

	// 11. Run using process-compose library
	fmt.Fprintln(os.Stderr, "\nStarting services with process-compose...")
	return RunProject(processComposePath, detach, sandboxCtx, fsys)
}

// createPostgresContainer creates the PostgreSQL container if it doesn't exist.
// Uses Docker API directly to create a stopped container that process-compose can start.
func createPostgresContainer(ctx context.Context, sandboxCtx *SandboxContext) error {
	containerName := sandboxCtx.ContainerName("db")
	volumeName := sandboxCtx.VolumeName("db")

	// Check if container already exists
	if _, err := utils.Docker.ContainerInspect(ctx, containerName); err == nil {
		// Container exists, just make sure it's stopped
		_ = utils.Docker.ContainerStop(ctx, containerName, container.StopOptions{})
		return nil
	}

	// Create volume if it doesn't exist
	_, _ = utils.Docker.VolumeCreate(ctx, volume.CreateOptions{
		Name: volumeName,
	})

	// Pull image if needed
	image := utils.GetRegistryImageUrl(utils.Config.Db.Image)
	if err := utils.DockerPullImageIfNotCached(ctx, image); err != nil {
		return fmt.Errorf("failed to pull postgres image: %w", err)
	}

	// Create container
	env := []string{
		"POSTGRES_PASSWORD=" + utils.Config.Db.Password,
		"JWT_SECRET=" + utils.Config.Auth.JwtSecret.Value,
		fmt.Sprintf("JWT_EXP=%d", utils.Config.Auth.JwtExpiry),
	}

	containerConfig := &container.Config{
		Image: image,
		Env:   env,
		Healthcheck: &container.HealthConfig{
			Test:        []string{"CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"},
			Interval:    10_000_000_000, // 10 seconds in nanoseconds
			Timeout:     2_000_000_000,  // 2 seconds
			Retries:     3,
			StartPeriod: 5_000_000_000, // 5 seconds
		},
	}

	hostConfig := &container.HostConfig{
		PortBindings: nat.PortMap{
			"5432/tcp": []nat.PortBinding{{
				HostIP:   "127.0.0.1",
				HostPort: strconv.Itoa(sandboxCtx.Ports.Postgres),
			}},
		},
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: volumeName,
				Target: "/var/lib/postgresql/data",
			},
		},
	}

	_, err := utils.Docker.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, containerName)
	if err != nil {
		return fmt.Errorf("failed to create container: %w", err)
	}

	return nil
}

// printStartupInfo displays the allocated ports and URLs to the user.
func printStartupInfo(ctx *SandboxContext) {
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Sandbox starting with ports:")
	fmt.Fprintf(os.Stderr, "  API (nginx):   http://127.0.0.1:%d\n", ctx.Ports.Nginx)
	fmt.Fprintf(os.Stderr, "  Database:      postgresql://postgres:postgres@127.0.0.1:%d/postgres\n", ctx.Ports.Postgres)
	fmt.Fprintf(os.Stderr, "  Auth (GoTrue): http://127.0.0.1:%d\n", ctx.Ports.GoTrue)
	fmt.Fprintf(os.Stderr, "  REST API:      http://127.0.0.1:%d\n", ctx.Ports.PostgREST)
}
