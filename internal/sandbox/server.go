package sandbox

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/f1bonacc1/process-compose/src/api"
	"github.com/f1bonacc1/process-compose/src/app"
	"github.com/f1bonacc1/process-compose/src/client"
	"github.com/f1bonacc1/process-compose/src/loader"
	"github.com/f1bonacc1/process-compose/src/types"
)

// RunServer runs the process-compose server in the foreground.
// This is meant to be called by a detached background process.
// It starts the runner, HTTP server, and waits for shutdown signals.
func RunServer(configPath string, serverPort int) error {
	// Load process-compose config
	loaderOpts := &loader.LoaderOptions{
		FileNames: []string{configPath},
	}

	project, err := loader.Load(loaderOpts)
	if err != nil {
		return fmt.Errorf("failed to load process-compose config: %w", err)
	}

	opts := &app.ProjectOpts{}
	opts.WithProject(project).WithIsTuiOn(false)

	runner, err := app.NewProjectRunner(opts)
	if err != nil {
		return fmt.Errorf("failed to create project runner: %w", err)
	}

	// Start HTTP server for remote control
	server, err := api.StartHttpServerWithTCP(false, "127.0.0.1", serverPort, runner)
	if err != nil {
		return fmt.Errorf("failed to start process-compose server on port %d: %w", serverPort, err)
	}

	// Set up signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Channel to receive runner errors
	errChan := make(chan error, 1)

	// Start the runner in a goroutine
	go func() {
		errChan <- runner.Run()
	}()

	// Wait for signal or runner exit
	select {
	case sig := <-sigChan:
		fmt.Fprintf(os.Stderr, "Received %v, shutting down...\n", sig)
		if err := runner.ShutDownProject(); err != nil {
			fmt.Fprintf(os.Stderr, "Error during shutdown: %v\n", err)
		}
		runner.WaitForProjectShutdown()
		shutdownHTTPServer(server)
		return nil
	case err := <-errChan:
		shutdownHTTPServer(server)
		return err
	}
}

// shutdownHTTPServer gracefully shuts down the HTTP server.
func shutdownHTTPServer(server *http.Server) {
	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: server shutdown error: %v\n", err)
	}
}

// WaitForServerReady polls the process-compose server until all services are healthy.
func WaitForServerReady(serverPort int, timeout time.Duration) error {
	pcClient := client.NewTcpClient("127.0.0.1", serverPort, 100)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	// Initial delay to let the server start
	time.Sleep(1 * time.Second)

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting for services to become healthy")
		case <-ticker.C:
			states, err := pcClient.GetProcessesState()
			if err != nil {
				// Server might not be ready yet
				continue
			}

			if isAllStatesReady(states) {
				return nil
			}
		}
	}
}

// isAllStatesReady checks if all services are ready based on client API response.
func isAllStatesReady(states *types.ProcessesState) bool {
	if states == nil {
		return false
	}
	for _, state := range states.States {
		if !isStateReady(&state) {
			return false
		}
	}
	return true
}

// isStateReady checks if a single service is ready.
func isStateReady(state *types.ProcessState) bool {
	switch state.Status {
	case types.ProcessStateCompleted, types.ProcessStateDisabled, types.ProcessStateSkipped:
		return true
	case types.ProcessStateRunning, types.ProcessStateLaunched:
		if state.HasHealthProbe {
			return state.Health == types.ProcessHealthReady
		}
		return true
	case types.ProcessStateLaunching:
		// Daemon processes might stay in Launching but be healthy
		if state.HasHealthProbe && state.Health == types.ProcessHealthReady {
			return true
		}
		return false
	default:
		return false
	}
}
