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

	"github.com/f1bonacc1/process-compose/src/client"
	"github.com/spf13/afero"
)

// Stop stops all sandbox services and cleans up resources.
// Uses process-compose HTTP API for graceful shutdown with proper dependency ordering.
// Falls back to killing the server PID if HTTP API is unavailable.
// If backup is false, also removes the postgres data directory.
func Stop(ctx context.Context, fsys afero.Fs, projectId string, backup bool, w io.Writer) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// Load state to find server PID and process-compose port
	state, err := sandboxCtx.LoadState(fsys)
	if err != nil {
		return fmt.Errorf("sandbox is not running (no state file): %w", err)
	}

	fmt.Fprintln(w, "Stopping services...")

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

	// Clean up all sandbox files (state, yaml, logs)
	if err := fsys.RemoveAll(sandboxCtx.ConfigDir); err != nil {
		fmt.Fprintf(w, "Warning: failed to cleanup sandbox files: %v\n", err)
	}

	// If no backup requested, also remove the postgres data directory
	if !backup {
		pgDataDir := sandboxCtx.PgDataDir()
		fmt.Fprintf(w, "Removing postgres data directory %s...\n", pgDataDir)
		if err := fsys.RemoveAll(pgDataDir); err != nil {
			fmt.Fprintf(w, "Warning: failed to remove postgres data dir: %v\n", err)
		}
	}

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

// Cleanup removes all sandbox-related resources for a project.
// This includes the config directory and postgres data directory.
func Cleanup(ctx context.Context, fsys afero.Fs, projectId string) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// First stop everything (with backup=true since Cleanup handles pgdata removal separately)
	if err := Stop(ctx, fsys, projectId, true, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: stop failed: %v\n", err)
	}

	// Remove postgres data directory
	pgDataDir := sandboxCtx.PgDataDir()
	fmt.Fprintf(os.Stderr, "Removing postgres data directory %s...\n", pgDataDir)
	if err := fsys.RemoveAll(pgDataDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove postgres data dir: %v\n", err)
	}

	// Remove config directory
	fmt.Fprintf(os.Stderr, "Removing config directory %s...\n", sandboxCtx.ConfigDir)
	if err := fsys.RemoveAll(sandboxCtx.ConfigDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove config dir: %v\n", err)
	}

	// Remove postgres version file
	if err := fsys.Remove(SandboxPostgresVersionPath); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove postgres version file: %v\n", err)
	}

	fmt.Fprintln(os.Stderr, "Sandbox cleanup complete.")
	return nil
}
