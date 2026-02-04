package sandbox

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/f1bonacc1/process-compose/src/client"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

// Stop stops all sandbox services and cleans up resources.
// Uses process-compose HTTP API for graceful shutdown with proper dependency ordering.
// Falls back to killing the server PID if HTTP API is unavailable.
func Stop(ctx context.Context, fsys afero.Fs, projectId string, w io.Writer) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// Load state to find server PID and process-compose port
	state, err := sandboxCtx.LoadState(fsys)
	if err != nil {
		return fmt.Errorf("sandbox is not running (no state file): %w", err)
	}

	fmt.Fprintln(w, "Stopping sandbox services...")

	// Try graceful shutdown via HTTP API first
	stopped := false
	if state.Ports.ProcessCompose > 0 {
		pcClient := client.NewTcpClient("127.0.0.1", state.Ports.ProcessCompose, 100)
		if err := pcClient.ShutDownProject(); err == nil {
			stopped = true
			// Give processes time to shut down gracefully
			time.Sleep(2 * time.Second)
		}
	}

	// Fallback: kill server PID (process-compose will clean up children)
	if !stopped && state.PID > 0 {
		fmt.Fprintf(w, "HTTP API unavailable, terminating server (PID %d)...\n", state.PID)
		if err := terminateProcess(state.PID); err != nil {
			fmt.Fprintf(w, "Warning: failed to terminate server: %v\n", err)
		}
		time.Sleep(2 * time.Second)
	}

	// Stop docker container using Docker API
	dbContainer := sandboxCtx.ContainerName("db")
	fmt.Fprintf(w, "Stopping container %s...\n", dbContainer)

	timeout := 10
	if err := utils.Docker.ContainerStop(ctx, dbContainer, container.StopOptions{
		Timeout: &timeout,
	}); err != nil {
		// Container might not exist or already be stopped
		fmt.Fprintf(w, "Note: %v\n", err)
	}

	// Clean up state file
	if err := sandboxCtx.CleanupState(fsys); err != nil {
		fmt.Fprintf(w, "Warning: failed to cleanup state: %v\n", err)
	}

	fmt.Fprintln(w, "Sandbox stopped.")
	return nil
}

// terminateProcess sends a termination signal to a process.
// On Unix, it sends SIGTERM for graceful shutdown.
// On Windows, it uses taskkill for graceful shutdown.
func terminateProcess(pid int) error {
	if pid <= 0 {
		return nil
	}

	if runtime.GOOS == "windows" {
		// On Windows, use taskkill for graceful shutdown
		cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid))
		return cmd.Run()
	}

	// On Unix, send SIGTERM for graceful shutdown
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(syscall.SIGTERM)
}

// Cleanup removes all sandbox-related Docker resources for a project.
// This includes the container and volume.
func Cleanup(ctx context.Context, fsys afero.Fs, projectId string) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// First stop everything
	if err := Stop(ctx, fsys, projectId, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: stop failed: %v\n", err)
	}

	// Remove container using Docker API
	dbContainer := sandboxCtx.ContainerName("db")
	fmt.Fprintf(os.Stderr, "Removing container %s...\n", dbContainer)
	if err := utils.Docker.ContainerRemove(ctx, dbContainer, container.RemoveOptions{Force: true}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove container: %v\n", err)
	}

	// Remove volume using Docker API
	dbVolume := sandboxCtx.VolumeName("db")
	fmt.Fprintf(os.Stderr, "Removing volume %s...\n", dbVolume)
	if err := utils.Docker.VolumeRemove(ctx, dbVolume, true); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove volume: %v\n", err)
	}

	// Remove config directory
	fmt.Fprintf(os.Stderr, "Removing config directory %s...\n", sandboxCtx.ConfigDir)
	if err := fsys.RemoveAll(sandboxCtx.ConfigDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove config dir: %v\n", err)
	}

	fmt.Fprintln(os.Stderr, "Sandbox cleanup complete.")
	return nil
}
